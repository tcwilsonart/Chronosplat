/**
 * main.js — bootstraps renderer, scene, camera, controls and UI; loads the
 * manifest and wires the modules together.
 *
 * Data flow:
 *   fetch manifest.json
 *     -> Sequencer (frameCount, playbackFps)
 *     -> FrameCache (resolved frame URLs)
 *     -> AudioTrack (only if manifest.audio exists)
 *     -> render loop asks Sequencer for the active index, FrameCache makes it
 *        resident and visible, Timeline reflects/controls Sequencer state.
 *
 * BACKEND NOTE:
 * Spark renders exclusively through THREE.WebGLRenderer and ships no WebGPU
 * backend, so the player requires WebGL2 and surfaces a clear error when it is
 * unavailable. WebGPU is still used for SOG *encode* in the converter (--gpu).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer } from '@sparkjsdev/spark';

import { config, readHashState } from './config.js';
import { Sequencer } from './Sequencer.js';
import { FrameCache } from './FrameCache.js';
import { Timeline } from './Timeline.js';
import { AudioTrack } from './AudioTrack.js';
import { ManifestStore } from './ManifestStore.js';

const ui = {
  status: document.getElementById('status'),
  statusText: document.querySelector('#status .status-text'),
  error: document.getElementById('error'),
  hud: document.getElementById('hud'),
  stats: document.getElementById('stats'),
};

function setStatus(text) {
  if (!ui.status) return;
  ui.status.hidden = false;
  if (ui.statusText) ui.statusText.textContent = text;
}

function clearStatus() {
  if (ui.status) ui.status.hidden = true;
}

function fatal(title, detail) {
  clearStatus();
  if (!ui.error) {
    console.error(title, detail);
    return;
  }
  ui.error.hidden = false;
  ui.error.innerHTML = `<h2></h2><p></p>`;
  ui.error.querySelector('h2').textContent = title;
  ui.error.querySelector('p').textContent = detail;
  console.error(title, detail);
}

/** fail loudly and usefully when no supported backend exists. */
function assertWebGL2() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    throw new Error(
      'WebGL2 is required to render Gaussian splats and is not available in ' +
      'this browser. Spark renders via WebGL2; enable hardware acceleration ' +
      'or try a current Chrome, Edge, Firefox or Safari.',
    );
  }
  const lose = gl.getExtension('WEBGL_lose_context');
  lose?.loseContext();
}

/** Resolve frame/audio URLs the same way for both. */
function resolveBase(manifestUrl, manifestBaseUrl) {
  const manifestAbs = new URL(manifestUrl, window.location.href);
  const base = config.baseUrlOverride ?? manifestBaseUrl ?? '';
  // Empty baseUrl -> resolve relative to the manifest's own URL (same-origin
  // GitHub Pages case, no CORS). A non-empty baseUrl points at another origin.
  return base ? new URL(base.endsWith('/') ? base : `${base}/`, manifestAbs).href
              : manifestAbs.href;
}

async function fetchManifest(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  if (!Array.isArray(m.frames) || m.frames.length === 0) {
    throw new Error('manifest has no frames[]');
  }
  const declared = m.frameCount;
  if (!Number.isInteger(declared) || declared < 1) {
    throw new Error(`manifest.frameCount is missing or invalid (${declared})`);
  }
  if (declared !== m.frames.length) {
    console.warn(
      `[main] manifest.frameCount (${declared}) != frames.length ` +
      `(${m.frames.length}); trusting frames.length.`,
    );
  }
  if (m.version !== 3) {
    console.warn(`[main] manifest version ${m.version}; this player targets v3.`);
  }
  return m;
}

/**
 * Load the sequence library index (data/index.json).
 *
 * Returns null when there is no index — a single-sequence deployment, or one
 * predating the library layout. The player then falls back to a lone manifest
 * and shows no dropdown, so both layouts work unchanged.
 */
async function loadIndex() {
  if (config.manifestUrl) return null; // explicit ?manifest= wins
  try {
    const res = await fetch(config.indexUrl, { cache: 'no-cache' });
    if (!res.ok) return null;
    const index = await res.json();
    const list = Array.isArray(index?.sequences) ? index.sequences : [];
    return list.length ? { ...index, sequences: list } : null;
  } catch {
    return null; // absent index is a normal, supported configuration
  }
}

async function boot() {
  try {
    assertWebGL2();
  } catch (err) {
    fatal('Unsupported browser', err.message);
    return;
  }

  // ---- sequence library ------------------------------------------------
  setStatus('Loading library…');
  const index = await loadIndex();

  let startEntry = null;
  if (index) {
    startEntry =
      (config.sequenceId && index.sequences.find((s) => s.id === config.sequenceId)) ||
      index.sequences[0];
    if (config.sequenceId && startEntry.id !== config.sequenceId) {
      console.warn(`[main] no sequence "${config.sequenceId}" in the index; ` +
                   `opening "${startEntry.id}" instead.`);
    }
  }

  const firstManifestUrl = startEntry
    ? new URL(startEntry.manifest, new URL(config.indexUrl, window.location.href)).href
    : (config.manifestUrl ?? config.manifestFallback);

  // ---- manifest -------------------------------------------------------
  setStatus('Loading manifest…');
  let manifest;
  try {
    manifest = validateManifest(await fetchManifest(firstManifestUrl));
  } catch (err) {
    fatal(
      'Could not load the sequence manifest',
      `${firstManifestUrl} — ${err.message}. Run the converter first ` +
      '(see README), or pass ?manifest=<url>.',
    );
    return;
  }

  const baseHref = resolveBase(firstManifestUrl, manifest.baseUrl);
  const urls = manifest.frames.map((f) => new URL(f.file, baseHref).href);
  const frameCount = manifest.frames.length;

  // ---- three.js scene -------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    antialias: config.antialias,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('viewport').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(config.background);

  // SparkRenderer performs the actual splat rendering and must be in the scene.
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  // ---- camera: URL override > manifest.camera > config defaults --
  const hashState = readHashState();
  const mc = manifest.camera ?? {};
  const cd = config.cameraDefaults;
  const co = config.cameraOverride;

  const position = co.position ?? hashState?.position ?? mc.position ?? cd.position;
  const target = co.target ?? hashState?.target ?? mc.target ?? cd.target;
  const up = mc.up ?? cd.up;
  const fov = co.fov ?? mc.fov ?? cd.fov;

  const camera = new THREE.PerspectiveCamera(
    fov, window.innerWidth / window.innerHeight, config.near, config.far,
  );
  camera.up.fromArray(up);
  camera.position.fromArray(position);
  camera.lookAt(new THREE.Vector3().fromArray(target));

  // Rotation is expressed as a look-at TARGET rather than Euler angles: it
  // composes directly with OrbitControls.target, needs no order convention,
  // and round-trips through the URL hash unambiguously.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.fromArray(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  // Sequence background overrides the config default, so each piece can carry
  // its own presentation.
  if (manifest.display?.background) {
    scene.background = new THREE.Color(manifest.display.background);
  }

  // ---- persistence -----------------------------------------------------
  const store = new ManifestStore();
  store.onStatus = (message) => {
    setStatus(message);
    setTimeout(clearStatus, 2200);
  };

  /** Save a presentation patch and mirror it into the in-memory manifest. */
  function persist(patch) {
    if (!currentSequenceId) {
      console.warn('[main] no sequence id; cannot persist', patch);
      return;
    }
    if (session) {
      for (const [k, v] of Object.entries(patch)) {
        session.manifest[k] = (v && typeof v === 'object' && !Array.isArray(v))
          ? { ...(session.manifest[k] ?? {}), ...v }
          : v;
      }
    }
    store.save(currentSequenceId, patch);
  }

  const round4 = (v) => Math.round(v * 10000) / 10000;

  /** Current background, kept here so Save Scene can persist what you see. */
  let background = manifest.display?.background ?? config.background;

  /** Apply a background to the scene and keep the swatch in sync. */
  function applyBackground(color) {
    background = color;
    scene.background = new THREE.Color(color);
    session?.timeline.setBackground(color);
  }

  /**
   * Stats overlay visibility. Toggled by the Stats button or the S key.
   *
   * Not driven solely by `?stats=1`: the player writes a deep-link hash
   * (`#f=..&p=..&t=..`) into the address bar continuously, so copying that URL
   * and appending `?stats=1` puts the query INSIDE the hash, where it is
   * silently ignored. A button and a key always work.
   */
  let showStats = config.showStats;
  function setShowStats(next) {
    showStats = Boolean(next);
    if (!showStats && ui.stats) ui.stats.hidden = true;
    session?.timeline.setStatsActive(showStats);
  }

  // ---- session ---------------------------------------------------------
  //
  // Everything above (renderer, scene, camera, controls, SparkRenderer) is
  // built once and OUTLIVES a sequence change. Everything below is per-
  // sequence and is torn down and rebuilt by `openSequence()`, so switching
  // sequences never leaks a SplatMesh or leaves a stale listener behind.
  /** @type {{sequencer: Sequencer, cache: FrameCache, audio: AudioTrack, timeline: Timeline, manifest: object, frameCount: number}|null} */
  let session = null;
  let prebuffering = false;
  let switching = false;
  let currentSequenceId = startEntry?.id ?? null;
  /** Timestamps of recent frame advances, for the effective-fps readout.
   *  Declared here (not at the render loop) because buildSession resets it. */
  let effWindow = [];

  function cancelPrebuffer() {
    if (prebuffering) {
      prebuffering = false;
      clearStatus();
    }
  }

  /**
   * Prebuffer before starting playback.
   *
   * Without this, pressing play immediately stalls: the first frame is decoded
   * but the second is not, so the transport would visibly hitch on frame 1
   * every single time. Waiting for a short run of consecutive frames makes
   * playback start smoothly.
   */
  async function playWhenBuffered() {
    if (!session) return;
    const { sequencer, cache } = session;
    const want = Math.min(config.prebufferFrames, session.frameCount - 1);
    if (want <= 0 || cache.bufferedRun(sequencer.index, want) >= want) {
      sequencer.play();
      return;
    }
    if (prebuffering) return;
    prebuffering = true;
    const mine = session;
    const deadline = Date.now() + 30000;
    try {
      for (;;) {
        if (session !== mine) return; // sequence changed under us
        const have = cache.bufferedRun(sequencer.index, want);
        if (have >= want || Date.now() > deadline) break;
        setStatus(`Buffering ${have}/${want}…`);
        await new Promise((r) => setTimeout(r, 120));
        if (!prebuffering) return; // cancelled by a pause/seek
      }
    } finally {
      if (prebuffering && session === mine) {
        prebuffering = false;
        clearStatus();
        sequencer.play();
      }
    }
  }

  function teardownSession() {
    if (!session) return;
    cancelPrebuffer();
    session.sequencer.pause();
    session.timeline.dispose();
    session.audio.dispose();
    session.cache.disposeAll(); // frees every resident SplatMesh
    session = null;
  }

  /** True when the URL asked for a specific view; it outranks everything. */
  const explicitView = Boolean(
    co.position || co.target || co.fov ||
    hashState?.position || hashState?.target,
  );

  /**
   * Whether we may auto-frame from the mesh's real bounds.
   *
   * Precedence for the initial view is:
   *   URL params  >  URL hash  >  manifest.camera  >  auto-frame  >  config
   *
   * Auto-framing is a LAST RESORT, not a default. It previously ran whenever
   * the URL was silent, which meant a hand-authored `manifest.camera` was
   * always overwritten a moment after load — position and target appeared not
   * to persist, while `fov` did, because frameCameraToMesh does not touch fov.
   * A manifest camera is an explicit authoring decision and must win.
   */
  const hasManifestCamera = (m) => Boolean(m?.camera?.position && m?.camera?.target);

  /** Build a fresh session for an already-fetched, validated manifest. */
  function buildSession(nextManifest, manifestUrl,
                        { applyCamera = false } = {}) {
    const autoFrame = !explicitView && !hasManifestCamera(nextManifest);
    const base = resolveBase(manifestUrl, nextManifest.baseUrl);
    const frameUrls = nextManifest.frames.map((f) => new URL(f.file, base).href);
    const count = nextManifest.frames.length;
    const nextFps = nextManifest.temporal?.playbackFps ?? config.fallbackFps;

    const sequencer = new Sequencer({
      frameCount: count,
      fps: nextFps,
      loop: config.loop,
      startFrame: applyCamera ? 1 : (hashState?.frame ?? config.startFrame),
      mode: config.playbackMode,
    });

    const cache = new FrameCache({
      scene,
      urls: frameUrls,
      preloadAhead: config.preloadAhead,
      preloadBehind: config.preloadBehind,
      maxConcurrentLoads: config.maxConcurrentLoads,
      retryAttempts: config.retryAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      // Orientation is a property of the SEQUENCE, not of the player.
      flipX: config.flipX ?? nextManifest.display?.flipX ?? config.flipXDefault,
    });

    // 'everyFrame' mode advances only when the next frame is decoded, so the
    // playhead stalls instead of skipping past frames that are not ready yet.
    sequencer.canAdvance = (i) => cache.isReady(i);

    // Constructed unconditionally, but inert when manifest.audio is absent.
    const audio = new AudioTrack({
      manifestAudio: nextManifest.audio,
      baseUrl: base,
      sequencer,
      defaultMuted: config.audioDefaultMuted,
      defaultVolume: config.audioDefaultVolume,
    });

    const timeline = new Timeline({
      mount: ui.hud,
      sequencer,
      audio,
      sequences: index?.sequences ?? null,
      activeSequenceId: currentSequenceId,
      onSelectSequence: (id) => openSequence(id),
      background: nextManifest.display?.background ?? config.background,
      onRequestPlay: playWhenBuffered,
      onCancelPlay: cancelPrebuffer,

      // Flip and the colour swatch change the VIEW only. Persisting is a
      // separate, explicit act (Save Scene), so experimenting never silently
      // rewrites a manifest you were happy with.
      onToggleFlip: () => {
        const flipped = cache.setFlipX(!cache.flipX);
        // Flipping moves the model, so the old framing may now miss it.
        const mesh = cache.entries.get(sequencer.index)?.mesh;
        if (mesh) frameCameraToMesh(mesh);
        timeline.setFlipActive(flipped);
      },

      onResetCamera: () => {
        // Prefer the authored view; auto-frame only if there is not one.
        if (hasManifestCamera(session?.manifest)) {
          applyManifestCamera(session.manifest);
        } else {
          const mesh = cache.entries.get(sequencer.index)?.mesh;
          if (mesh) frameCameraToMesh(mesh);
        }
      },

      // One button, everything the viewer currently shows.
      onSaveScene: () => {
        persist({
          camera: {
            position: camera.position.toArray().map(round4),
            target: controls.target.toArray().map(round4),
            up: camera.up.toArray().map(round4),
            fov: round4(camera.fov),
          },
          display: {
            flipX: cache.flipX,
            background,
          },
        });
      },

      onToggleStats: () => setShowStats(!showStats),

      onPreviewBackground: (color) => applyBackground(color),
    });
    timeline.setFlipActive(cache.flipX);
    timeline.setStatsActive(showStats);

    if (audio.available) {
      audio.onNeedsGesture = () => {
        setStatus('Click anywhere to enable sound');
        const once = () => {
          audio.unlock();
          clearStatus();
          window.removeEventListener('pointerdown', once);
        };
        window.addEventListener('pointerdown', once, { once: true });
      };
    }

    setStatus('Loading first frame…');
    cache.onActiveReady = (i) => {
      if (session?.sequencer !== sequencer || i !== sequencer.index) return;
      clearStatus();
      cache.onActiveReady = null;

      // Only auto-frame when there is no authored camera to honour.
      if (autoFrame) {
        const mesh = cache.entries.get(i)?.mesh;
        if (mesh) frameCameraToMesh(mesh);
      }

      if (!config.startPaused) playWhenBuffered();
    };
    cache.onFrameFailed = (i) => {
      console.warn(`[main] frame ${i + 1} unavailable; playback continues.`);
    };

    session = { sequencer, cache, audio, timeline,
                manifest: nextManifest, frameCount: count };
    effWindow = [];

    // Background is a per-sequence presentation choice, so it must follow the
    // sequence — not stay on whatever the previously-viewed one used.
    applyBackground(nextManifest.display?.background ?? config.background);

    // A new sequence has its own extents, so re-frame the camera to it.
    if (applyCamera) applyManifestCamera(nextManifest);

    console.info(
      `[chronosplat] ${nextManifest.project ?? 'sequence'}: ${count} frames @ ${nextFps} fps, ` +
      `SH degree ${nextManifest.encode?.shDegree ?? '?'}, ` +
      `resident window ${cache.windowSize}/${count}`,
    );
  }

  /** Point the camera at a manifest's default framing. */
  function applyManifestCamera(m) {
    const cam = m.camera;
    if (!cam?.position || !cam?.target) return;
    camera.position.fromArray(cam.position);
    controls.target.fromArray(cam.target);
    if (cam.fov) {
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
    }
    controls.update();
  }

  /**
   * Frame the camera to a decoded mesh's REAL world-space bounds.
   *
   * Why this exists rather than just trusting `manifest.camera`: the converter
   * derives bounds and camera from raw PLY coordinates, but the player applies
   * a 180 deg X rotation to every mesh (config.flipX). Those are different
   * spaces. A model that is roughly symmetric about Y survives the mismatch by
   * luck — the reference excavator does — but one that is not lands completely
   * out of frame. bogdanFly sits at Y +0.02..+0.61 in PLY space, so the flip
   * put it a full model-height below the manifest's target and the viewport
   * rendered black.
   *
   * Measuring the mesh after it is loaded and transformed is orientation- and
   * exporter-agnostic, so it cannot drift out of sync with the display
   * transform. It also means no camera has to be authored for a sane default.
   */
  function frameCameraToMesh(mesh) {
    let box;
    try {
      box = mesh.getBoundingBox?.(true);
    } catch {
      box = null;
    }
    if (!box || box.isEmpty?.()) return false;

    // getBoundingBox reports splat-local coordinates; move into world space so
    // the mesh's own rotation/position are accounted for.
    mesh.updateMatrixWorld(true);
    const world = box.clone().applyMatrix4(mesh.matrixWorld);
    if (world.isEmpty()) return false;

    const center = world.getCenter(new THREE.Vector3());
    const size = world.getSize(new THREE.Vector3());
    const radius = Math.max(1e-4, size.length() / 2);

    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const dist = (radius / Math.sin(fovRad / 2)) * 1.15; // 15% margin

    // Keep the current viewing DIRECTION so a sequence switch does not also
    // spin the camera; only re-centre and re-distance.
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-8) dir.set(0.57, 0.34, 0.75);
    dir.normalize();

    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(0.001, dist - radius * 4);
    camera.far = dist + radius * 8;
    camera.updateProjectionMatrix();
    controls.update();
    return true;
  }

  /** Switch to another sequence from the library index. */
  async function openSequence(id) {
    if (!index || switching) return;
    const entry = index.sequences.find((s) => s.id === id);
    if (!entry || id === currentSequenceId) return;

    switching = true;
    try {
      const url = new URL(entry.manifest,
                          new URL(config.indexUrl, window.location.href)).href;
      setStatus(`Loading ${entry.name}…`);
      const next = validateManifest(await fetchManifest(url));
      teardownSession();
      currentSequenceId = entry.id;
      buildSession(next, url, { applyCamera: true });
      // Keep the URL shareable: ?seq= identifies which sequence is open.
      const params = new URLSearchParams(window.location.search);
      params.set('seq', entry.id);
      history.replaceState(null, '',
        `${window.location.pathname}?${params}${window.location.hash}`);
    } catch (err) {
      console.error('[main] failed to open sequence', id, err);
      setStatus(`Could not load ${entry.name}`);
      setTimeout(clearStatus, 3000);
    } finally {
      switching = false;
    }
  }

  // Expose for console debugging and for the acceptance checks. Uses live
  // getters so it always reflects the CURRENT session after a sequence swap.
  window.__player = makeDebugHandle(() => ({
    session, camera, controls, renderer, index, currentSequenceId, openSequence,
  }));

  buildSession(manifest, firstManifestUrl);

  // ---- resize ----------------------------------------------------------
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // ---- deep link -------------------------------------------------
  let lastHashWrite = 0;
  const writeHash = (now) => {
    if (!config.deepLink) return;
    if (now - lastHashWrite < config.deepLinkThrottleMs) return;
    lastHashWrite = now;
    if (!session) return;
    const p = camera.position;
    const t = controls.target;
    const f3 = (v) => v.toFixed(3);
    const hash =
      `f=${session.sequencer.frameNumber}` +
      `&p=${f3(p.x)},${f3(p.y)},${f3(p.z)}` +
      `&t=${f3(t.x)},${f3(t.y)},${f3(t.z)}`;
    history.replaceState(null, '', `#${hash}`);
  };

  // ---- render loop -----------------------------------------------------
  let lastStatsWrite = 0;
  const round2 = (v) => Math.round(v * 10) / 10;

  /**
   * Stats overlay visibility.
   *
   * Also toggleable with the S key, not only `?stats=1`. The player writes a
   * deep-link hash (`#f=..&p=..&t=..`) into the address bar continuously, so
   * copying that URL and appending `?stats=1` puts the query INSIDE the hash,
   * where it is silently ignored. A key that always works avoids that trap.
   */
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyS' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    setShowStats(!showStats);
  });

  renderer.setAnimationLoop((timeMs) => {
    const now = timeMs ?? performance.now();

    controls.update();

    if (session) {
      const { sequencer, cache, timeline, audio } = session;
      if (sequencer.tick(now)) effWindow.push(now);

      cache.update(
        sequencer.index,
        sequencer.windowIndices(config.preloadAhead, config.preloadBehind),
      );
      timeline.setLoadingFrame(cache.activePending || sequencer.stalled);
      audio.tick();
    }

    renderer.render(scene, camera);

    writeHash(now);

    if (showStats && ui.stats && session && now - lastStatsWrite > 250) {
      lastStatsWrite = now;
      const { sequencer, cache } = session;
      const s = cache.stats();
      ui.stats.hidden = false;
      // Effective fps: what the viewer actually sees, which in everyFrame mode
      // is decode-bound and well below the authored playbackFps. Trim to a 2 s
      // sliding window.
      while (effWindow.length && now - effWindow[0] > 2000) effWindow.shift();
      const effFps = effWindow.length > 1
        ? (effWindow.length - 1) / ((now - effWindow[0]) / 1000) : 0;

      ui.stats.textContent = formatStats(session, sequencer, s, effFps,
                                         currentSequenceId, round2);
    }
  });

  window.addEventListener('beforeunload', () => teardownSession());
}

/**
 * Stats overlay text: live playback state PLUS what the conversion actually
 * did, so "is this slow/ugly because of the encode or because of playback?"
 * can be answered without opening the manifest.
 */
function formatStats(session, sequencer, cacheStats, effFps, seqId, round2) {
  const m = session.manifest;
  const src = m.source ?? {};
  const enc = m.encode ?? {};
  const temporal = m.temporal ?? {};
  const frames = m.frames ?? [];

  const totalBytes = frames.reduce((a, f) => a + (f.bytes || 0), 0);
  const mib = (b) => `${(b / 1048576).toFixed(1)} MiB`;
  const splats = frames[0]?.splats;

  // SH in vs out — the headline fidelity trade.
  const shIn = src.shPresent === false ? 'none' : (src.sourceShDegree ?? '?');
  const shOut = enc.shDegree ?? '?';
  const shNote = (src.shPresent !== false && shOut < (src.sourceShDegree ?? 0))
    ? `  (reduced from ${shIn})` : '';

  return [
    `${m.project ?? seqId ?? 'sequence'}   frame ${sequencer.frameNumber}/${session.frameCount}` +
      `   mode ${sequencer.mode}${sequencer.stalled ? ' (stalled)' : ''}`,
    `playback   target ${round2(sequencer.fps)} fps   effective ${round2(effFps)} fps`,
    `memory     resident ${cacheStats.resident}/${cacheStats.budget}` +
      `   ready ${cacheStats.ready} loading ${cacheStats.loading} failed ${cacheStats.failed}`,
    '',
    `source     ${src.sourceFrameCount ?? '?'} frames @ ${src.sourceFps ?? '?'} fps` +
      `   SH ${shIn}`,
    `encoded    ${session.frameCount} frames @ ${temporal.playbackFps ?? '?'} fps` +
      `   SH ${shOut}${shNote}`,
    `quality    ${enc.quality ?? '?'}` +
      `   ${splats ? splats.toLocaleString() : '?'} splats/frame` +
      `   ${mib(totalBytes / Math.max(1, frames.length))}/frame`,
    `total      ${mib(totalBytes)}` +
      (enc.normalized ? '   (normalized)' : ''),
  ].join('\n');
}

/** Expose the live session for console debugging and the smoke tests. */
function makeDebugHandle(get) {
  return {
    get sequencer() { return get().session?.sequencer; },
    get cache() { return get().session?.cache; },
    get audio() { return get().session?.audio; },
    get manifest() { return get().session?.manifest; },
    get camera() { return get().camera; },
    get controls() { return get().controls; },
    get renderer() { return get().renderer; },
    get sequences() { return get().index?.sequences ?? null; },
    get sequenceId() { return get().currentSequenceId; },
    openSequence: (id) => get().openSequence(id),
  };
}

boot().catch((err) => fatal('Player failed to start', err?.message ?? String(err)));
