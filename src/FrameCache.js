/**
 * FrameCache.js — bounded, streaming store of decoded Spark SplatMesh frames.
 *
 * All frames must NEVER be simultaneously GPU-resident.
 * The cache holds at most `preloadAhead + preloadBehind + 1` meshes; anything
 * outside that window is disposed, which is what actually frees the VRAM.
 *
 * Spark 2.1.0 API used here (from the shipped type definitions):
 *   new SplatMesh({ url })      -> constructs and begins loading
 *   mesh.initialized            -> Promise<SplatMesh>, resolves when renderable
 *   mesh.isInitialized          -> boolean
 *   mesh.dispose()              -> frees the buffers it holds
 *
 * A failed fetch retries with backoff, then is marked failed and skipped
 * with a warning — playback continues rather than crashing.
 */

import { SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

const State = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  FAILED: 'failed',
};

export class FrameCache {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {string[]}    opts.urls           resolved absolute/relative frame URLs
   * @param {number}      opts.preloadAhead
   * @param {number}      opts.preloadBehind
   * @param {number}      opts.maxConcurrentLoads
   * @param {number}      opts.retryAttempts
   * @param {number}      opts.retryBaseDelayMs
   * @param {boolean}     opts.flipX          apply the Y-down -> Y-up correction
   */
  constructor({
    scene,
    urls,
    preloadAhead = 8,
    preloadBehind = 2,
    maxConcurrentLoads = 3,
    retryAttempts = 2,
    retryBaseDelayMs = 400,
    flipX = true,
  }) {
    this.scene = scene;
    this.urls = urls;
    this.preloadAhead = preloadAhead;
    this.preloadBehind = preloadBehind;
    this.maxConcurrentLoads = maxConcurrentLoads;
    this.retryAttempts = retryAttempts;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.flipX = flipX;

    /** @type {Map<number, {state: string, mesh: SplatMesh|null, lastUsed: number, attempts: number, promise: Promise|null, error: Error|null}>} */
    this.entries = new Map();
    this._activeIndex = -1;
    this._inFlight = 0;
    this._clock = 0;
    /** Index of the mesh currently on screen. May lag `_activeIndex` while the
     *  active frame is still loading — see the hold-last-frame rule in
     *  `update()`. -1 means nothing has ever been shown. */
    this._visibleIndex = -1;
    /** Set when the active frame is not yet renderable — drives the spinner. */
    this.activePending = false;

    this.onFrameFailed = null; // (index, error) => void
    this.onActiveReady = null; // (index) => void
  }

  get residentCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.mesh) n++;
    return n;
  }

  /** Upper bound on simultaneously resident meshes — the memory budget.
   *
   *  The `+ 1` accounts for the held frame: when the active frame is still
   *  loading we keep the last-shown mesh alive (and exempt from eviction) so
   *  the viewport never blanks. That frame can sit outside the window, so the
   *  true ceiling is one above the window itself. */
  get windowSize() {
    return Math.min(this.urls.length, this.preloadAhead + this.preloadBehind + 2);
  }

  /** True when frame `index` is decoded and ready to display. */
  isReady(index) {
    return this.entries.get(index)?.state === State.READY;
  }

  /** How many consecutive frames starting at `index` are already decoded.
   *  Used to decide whether enough is buffered to start playing. */
  bufferedRun(index, limit = 16) {
    let n = 0;
    for (let i = 0; i < limit; i++) {
      const at = ((index + i) % this.urls.length + this.urls.length) % this.urls.length;
      if (!this.isReady(at)) break;
      n++;
    }
    return n;
  }

  stats() {
    let ready = 0, loading = 0, failed = 0;
    for (const e of this.entries.values()) {
      if (e.state === State.READY) ready++;
      else if (e.state === State.LOADING) loading++;
      else if (e.state === State.FAILED) failed++;
    }
    return { ready, loading, failed, resident: this.residentCount, budget: this.windowSize };
  }

  // ------------------------------------------------------------------
  // loading
  // ------------------------------------------------------------------

  _entry(index) {
    let e = this.entries.get(index);
    if (!e) {
      e = { state: State.IDLE, mesh: null, lastUsed: 0, attempts: 0, promise: null, error: null };
      this.entries.set(index, e);
    }
    return e;
  }

  /**
   * Ensure frame `index` is loading or loaded.
   * @param {boolean} urgent bypass the concurrency cap (the active frame must
   *                         never wait behind speculative preloads)
   */
  request(index, urgent = false) {
    if (index < 0 || index >= this.urls.length) return null;
    const e = this._entry(index);
    e.lastUsed = ++this._clock;

    if (e.state === State.READY || e.state === State.LOADING) return e.promise;
    if (e.state === State.FAILED && e.attempts > this.retryAttempts) return null;
    if (!urgent && this._inFlight >= this.maxConcurrentLoads) return null;

    e.state = State.LOADING;
    e.promise = this._load(index, e);
    return e.promise;
  }

  async _load(index, entry) {
    this._inFlight++;
    try {
      for (let attempt = 0; ; attempt++) {
        entry.attempts = attempt + 1;
        try {
          const mesh = await this._construct(this.urls[index]);
          // The window may have moved past this frame while it loaded; if so,
          // drop it immediately rather than leaking it outside the budget.
          if (!this._inWindow(index)) {
            mesh.dispose();
            entry.state = State.IDLE;
            entry.mesh = null;
            entry.promise = null;
            return null;
          }
          mesh.visible = index === this._activeIndex;
          this.scene.add(mesh);
          entry.mesh = mesh;
          entry.state = State.READY;
          entry.error = null;
          if (index === this._activeIndex) {
            this.activePending = false;
            this.onActiveReady?.(index);
          }
          return mesh;
        } catch (err) {
          if (attempt >= this.retryAttempts) {
            // Skip-and-warn: playback continues without this frame.
            entry.state = State.FAILED;
            entry.error = err;
            entry.mesh = null;
            console.warn(
              `[FrameCache] frame ${index + 1} failed after ${attempt + 1} attempt(s); ` +
              `skipping it. ${this.urls[index]}`, err,
            );
            this.onFrameFailed?.(index, err);
            return null;
          }
          const delay = this.retryBaseDelayMs * 2 ** attempt;
          console.warn(
            `[FrameCache] frame ${index + 1} load failed (attempt ${attempt + 1}), ` +
            `retrying in ${delay} ms`, err,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } finally {
      this._inFlight--;
      entry.promise = null;
    }
  }

  /** Construct a SplatMesh and resolve once it is actually renderable. */
  async _construct(url) {
    const mesh = new SplatMesh({ url });
    try {
      await mesh.initialized;
    } catch (err) {
      // Ensure a partially-constructed mesh never leaks GPU memory.
      try { mesh.dispose(); } catch { /* already torn down */ }
      throw err;
    }
    if (this.flipX) {
      // 180 deg about X: standard INRIA/COLMAP Y-down -> THREE.js Y-up.
      // Matches Spark's own README example. Toggle via config.flipX / ?flipX=0.
      mesh.quaternion.set(1, 0, 0, 0);
    }
    mesh.visible = false;
    return mesh;
  }

  // ------------------------------------------------------------------
  // window maintenance
  // ------------------------------------------------------------------

  _inWindow(index) {
    return this._window?.includes(index) ?? false;
  }

  /**
   * Make `index` the visible frame and reshape the resident window around it.
   * Call once per rendered frame.
   *
   * @param {number}   activeIndex
   * @param {number[]} windowIndices nearest-first, from Sequencer.windowIndices
   */
  update(activeIndex, windowIndices) {
    const changed = activeIndex !== this._activeIndex;
    this._activeIndex = activeIndex;
    this._window = windowIndices;

    // 1. Active frame first, bypassing the concurrency cap.
    const active = this._entry(activeIndex);
    active.lastUsed = ++this._clock;
    if (active.state === State.IDLE) {
      this.activePending = true;
      this.request(activeIndex, true);
    } else if (active.state === State.LOADING) {
      this.activePending = true;
    } else if (active.state === State.READY) {
      this.activePending = false;
    } else if (active.state === State.FAILED) {
      // Nothing to show; leave the previous frame up rather than blanking.
      this.activePending = false;
    }

    // 2. Exactly one mesh visible — and NEVER zero.
    //
    // The rule is "swap only when there is something to swap to". Previously
    // this hid every mesh whenever the active frame was not READY, which
    // blanked the viewport to the background colour for the entire duration of
    // playback: at 24 fps the window advances every ~42 ms while a frame costs
    // ~150 ms to fetch and decode, so the active frame is almost never ready.
    //
    // Holding the last decoded frame instead degrades to a lower *effective*
    // frame rate rather than to a black screen.
    if (active.state === State.READY && this._visibleIndex !== activeIndex) {
      for (const [i, e] of this.entries) {
        if (e.mesh) e.mesh.visible = i === activeIndex;
      }
      this._visibleIndex = activeIndex;
    }

    // 3. Speculative preloads, nearest-first.
    for (const i of windowIndices) {
      if (i === activeIndex) continue;
      const e = this._entry(i);
      e.lastUsed = Math.max(e.lastUsed, this._clock - windowIndices.indexOf(i));
      if (e.state === State.IDLE) this.request(i, false);
    }

    // 4. Evict everything outside the window. This is the memory-bound
    //    point — without the dispose() call VRAM grows without bound.
    //    The held frame is exempt: disposing what is currently on screen is
    //    what caused the blanking in the first place.
    const keep = new Set(windowIndices);
    if (this._visibleIndex >= 0) keep.add(this._visibleIndex);
    this._evict(keep);
  }

  _evict(keep) {
    for (const [i, e] of [...this.entries]) {
      if (keep.has(i)) continue;
      // Losing the on-screen mesh means there is nothing held any more.
      if (i === this._visibleIndex) this._visibleIndex = -1;
      if (e.state === State.LOADING) continue; // let it settle; _load re-checks
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.dispose();
        e.mesh = null;
      }
      // Keep FAILED entries so exhausted retries are not restarted on loop;
      // drop everything else so a later visit reloads cleanly.
      if (e.state !== State.FAILED) this.entries.delete(i);
      else e.state = State.FAILED;
    }
  }

  /**
   * Change the display orientation at runtime and re-apply it to every mesh
   * already decoded. Lets an operator find the correct value for a new
   * sequence by eye before recording it in the manifest, without a re-encode.
   */
  setFlipX(value) {
    const next = Boolean(value);
    if (next === this.flipX) return this.flipX;
    this.flipX = next;
    for (const [, e] of this.entries) {
      if (!e.mesh) continue;
      if (next) e.mesh.quaternion.set(1, 0, 0, 0);
      else e.mesh.quaternion.set(0, 0, 0, 1);
    }
    return this.flipX;
  }

  /** Force a retry of a frame that previously exhausted its attempts. */
  reset(index) {
    const e = this.entries.get(index);
    if (e && e.state === State.FAILED) {
      e.state = State.IDLE;
      e.attempts = 0;
      e.error = null;
    }
  }

  /** Tear everything down (page unload / manifest swap). */
  disposeAll() {
    for (const [, e] of this.entries) {
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.dispose();
        e.mesh = null;
      }
    }
    this.entries.clear();
    this._activeIndex = -1;
    this._visibleIndex = -1;
    this._window = [];
  }
}
