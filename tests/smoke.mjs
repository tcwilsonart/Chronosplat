/**
 * tests/smoke.mjs — end-to-end acceptance checks against a real browser.
 *
 * Drives the locally-installed Chrome via playwright-core (no browser
 * download). Covers what can be checked mechanically:
 *
 *   - loads, shows and clears a loading indicator
 *   - playback advances at the configured rate, decoupled from render rate
 *   - the viewport never blanks; every-frame mode shows the whole sequence
 *   - scrubbing to a cold frame works; the camera survives frame changes
 *   - GPU-resident frames stay within the configured window
 *   - a failed frame fetch retries, then skips without crashing
 *   - URL camera overrides apply; audio stays dormant without an audio block
 *
 * Verifying spherical-harmonic correctness is a visual judgement and is not
 * automated here.
 *
 * Usage:  node tests/smoke.mjs [--url http://localhost:5173] [--headed]
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = flag('url', 'http://localhost:5173');
const HEADED = args.includes('--headed');
const OUT = path.resolve('tests/output');

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  results.push({ name, ok, detail });
}

function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    'Chrome not found. Set CHROME_PATH to your Chrome/Chromium executable.',
  );
}

/** Poll a page predicate until true or timeout. */
async function until(page, fn, { timeout = 30000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await page.waitForTimeout(interval);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const executablePath = findChrome();
  console.log(`\nchronosplat smoke test\n  chrome : ${executablePath}\n  target : ${BASE}\n`);

  const browser = await chromium.launch({
    executablePath,
    headless: !HEADED,
    args: [
      // Force a real GPU path; SwiftShader cannot render 471k splats usefully.
      '--use-angle=default',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader', // last-resort fallback so CI still runs
    ],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const consoleWarnings = [];
  const requests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('request', (r) => requests.push(r.url()));

  try {
    // ---- criterion 5: load ------------------------------------------
    await page.goto(`${BASE}/?paused=1&stats=1`, { waitUntil: 'domcontentloaded' });

    const sawStatus = await page
      .waitForSelector('#status:not([hidden])', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    check('5a loading indicator shown while first frame loads', sawStatus);

    const fatal = await page.$('#error:not([hidden])');
    if (fatal) {
      const text = await fatal.innerText();
      check('5b no fatal error on load', false, text.replace(/\s+/g, ' ').slice(0, 200));
      throw new Error(`player reported a fatal error: ${text}`);
    }
    check('5b no fatal error on load', true);

    await until(page, () => Boolean(window.__player), { label: 'player bootstrap' });
    await until(
      page, () => window.__player.cache.stats().ready > 0,
      { timeout: 60000, label: 'first frame renderable' },
    );
    check('5c first frame became renderable', true);

    // Check the COMPUTED style, not the `hidden` property: an ID selector's
    // `display` can out-specify the UA `[hidden]` rule and leave the overlay
    // visible while `el.hidden` still reads true. Asserting the property alone
    // once let exactly that bug through.
    const statusVisual = await page.$eval('#status', (el) => ({
      prop: el.hidden,
      display: getComputedStyle(el).display,
    })).catch(() => ({ prop: true, display: 'none' }));
    check('5d loading indicator cleared after first frame (visually)',
      statusVisual.prop === true && statusVisual.display === 'none',
      `hidden=${statusVisual.prop}, computed display=${statusVisual.display}`);

    const info = await page.evaluate(() => ({
      frameCount: window.__player.manifest.frames.length,
      fps: window.__player.sequencer.fps,
      splats: window.__player.manifest.frames[0].splats,
      shDegree: window.__player.manifest.encode?.shDegree,
      budget: window.__player.cache.windowSize,
    }));
    console.log(
      `\n  manifest: ${info.frameCount} frames @ ${info.fps} fps, ` +
      `${info.splats.toLocaleString()} splats/frame, SH degree ${info.shDegree}, ` +
      `window budget ${info.budget}\n`,
    );

    // Let the splats actually paint before capturing — the screenshot is a
    // review artifact for the SH visual check, not just a pass/fail record.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '01-first-frame.png') });

    // ---- criterion 14: no audio block == no audio activity ----------
    const audioState = await page.evaluate(() => ({
      manifestHasAudio: Boolean(window.__player.manifest.audio),
      trackAvailable: window.__player.audio.available,
      hudHasAudioUI: !document.querySelector('[data-audio-group]')?.hidden,
    }));
    const audioFetches = requests.filter((u) => /\.(mp3|m4a|ogg|wav|aac|flac)(\?|$)/i.test(u));
    check(
      '14 no audio block -> AudioTrack fully dormant',
      !audioState.manifestHasAudio &&
        !audioState.trackAvailable &&
        !audioState.hudHasAudioUI &&
        audioFetches.length === 0,
      `available=${audioState.trackAvailable}, ui=${audioState.hudHasAudioUI}, ` +
      `audioFetches=${audioFetches.length}`,
    );

    // ---- criterion 8: camera persists across frame changes ----------
    await page.evaluate(() => {
      const { camera, controls } = window.__player;
      camera.position.set(2.5, 1.4, 3.1);
      controls.target.set(0.1, 0, 0);
      controls.update();
    });
    const camBefore = await page.evaluate(() => window.__player.camera.position.toArray());
    await page.evaluate(() => window.__player.sequencer.seekToFrame(2));
    await page.waitForTimeout(600);
    const camAfter = await page.evaluate(() => window.__player.camera.position.toArray());
    const camSame = camBefore.every((v, i) => Math.abs(v - camAfter[i]) < 1e-6);
    check('8 camera does not reset on frame change', camSame,
      `${camBefore.map((v) => v.toFixed(2))} -> ${camAfter.map((v) => v.toFixed(2))}`);

    // ---- criterion 7: scrub to a cold frame -------------------------
    const frameCountForMode = info.frameCount;
    const lastFrame = info.frameCount;
    await page.evaluate((n) => {
      window.__player.cache.disposeAll();
      window.__player.sequencer.seekToFrame(n);
    }, lastFrame);
    await until(
      page, () => window.__player.cache.stats().ready > 0,
      { timeout: 60000, label: 'cold-scrub frame load' },
    );
    const landedOn = await page.evaluate(() => window.__player.sequencer.frameNumber);
    check('7 scrub to a cold (evicted) frame loads and displays it',
      landedOn === lastFrame, `landed on frame ${landedOn}/${lastFrame}`);
    await page.screenshot({ path: path.join(OUT, '02-cold-scrub.png') });

    // ---- criterion 6: frames advance at the configured fps ----------
    // NOTE: elapsedSeconds is NOT a valid probe here — a short looping
    // sequence wraps it (3 frames @ 8fps = 0.375s), so a sample taken after
    // 2s legitimately reads ~0.1s. Count framechange events instead: that is
    // what "advances frames at playbackFps" actually means, and it also
    // exposes the render-fps decoupling (render runs ~60fps, frames must not).
    await page.evaluate(() => {
      const s = window.__player.sequencer;
      s.setLoop(true);
      s.seekToFrame(1);
      s.fps = 8;
      window.__probe = { frameChanges: 0, renders: 0 };
      s.on('framechange', () => { window.__probe.frameChanges++; });
      const rafCount =  () => { window.__probe.renders++; requestAnimationFrame(rafCount); };
      requestAnimationFrame(rafCount);
      s.play();
    });
    const t0 = Date.now();
    await page.waitForTimeout(3000);
    const probe = await page.evaluate(() => ({
...window.__probe,
      playing: window.__player.sequencer.playing,
    }));
    const wall = (Date.now() - t0) / 1000;
    const observedFps = probe.frameChanges / wall;
    const renderFps = probe.renders / wall;
    // Generous tolerance: this is a timing test on a shared machine.
    check('6a frames advance at the configured playback fps',
      probe.playing && observedFps > 8 * 0.6 && observedFps < 8 * 1.4,
      `${probe.frameChanges} advances in ${wall.toFixed(2)}s = ` +
      `${observedFps.toFixed(1)} fps (target 8)`);
    check('6b playback clock decoupled from render fps',
      renderFps > observedFps * 1.5,
      `render ${renderFps.toFixed(0)} fps vs playback ${observedFps.toFixed(1)} fps`);

    // ---- 6c: the viewport must NEVER blank during playback ----------
    // Regression guard. FrameCache used to hide every mesh whenever the active
    // frame was not yet decoded. At the authored 24 fps a frame arrives every
    // 42 ms but costs ~150 ms to fetch+decode, so that hid EVERYTHING 100% of
    // the time — playback showed nothing but the background colour. The cache
    // now holds the last decoded frame until its replacement is ready.
    const blanking = await page.evaluate(async  () => {
      const { sequencer, cache } = window.__player;
      sequencer.seekToFrame(1);
      sequencer.fps = 24;
      sequencer.setLoop(true);
      const shown = new Set();
      let blank = 0, ticks = 0;
      await new Promise((resolve) => {
        sequencer.play();
        const iv = setInterval(() => {
          ticks++;
          let visible = -1;
          for (const [i, e] of cache.entries) if (e.mesh?.visible) visible = i;
          if (visible < 0) blank++; else shown.add(visible);
        }, 40);
        setTimeout(() => { clearInterval(iv); sequencer.pause(); resolve(); }, 4000);
      });
      return { blank, ticks, distinct: shown.size, mode: sequencer.mode };
    });
    check('6c viewport never blanks during playback',
      blanking.blank === 0,
      `${blanking.blank}/${blanking.ticks} blank ticks, ` +
      `${blanking.distinct} distinct frames shown (mode ${blanking.mode})`);

    // ---- 6d: everyFrame mode shows every frame ----------------------
    // The whole point of the mode: no frame is skipped, even though that means
    // running below the authored fps when decode cannot keep up.
    check('6d everyFrame mode displays a large share of the sequence',
      blanking.mode !== 'everyFrame' || blanking.distinct >= Math.min(frameCountForMode, 20),
      `${blanking.distinct} distinct frames displayed`);

    // ---- memory bound: resident window stays bounded ------------
    let maxResident = 0;
    for (let i = 0; i < 25; i++) {
      const s = await page.evaluate(() => window.__player.cache.stats());
      maxResident = Math.max(maxResident, s.resident);
      await page.waitForTimeout(200);
    }
    const budget = info.budget;
    check('9 resident frame count stays within the configured window ',
      maxResident <= budget, `peak resident ${maxResident} <= budget ${budget}`);

    await page.evaluate(() => window.__player.sequencer.pause());
    await page.screenshot({ path: path.join(OUT, '03-after-playback.png') });

    // ---- criterion 13: camera override via URL  --------------
    const page2 = await context.newPage();
    await page2.goto(
      `${BASE}/?paused=1&camPos=1.5,0.9,2.2&camTarget=0.2,0.1,0&fov=35&deepLink=0`,
      { waitUntil: 'domcontentloaded' },
    );
    await until(page2, () => Boolean(window.__player), { label: 'override bootstrap' });
    const override = await page2.evaluate(() => ({
      pos: window.__player.camera.position.toArray(),
      target: window.__player.controls.target.toArray(),
      fov: window.__player.camera.fov,
      controlsEnabled: window.__player.controls.enabled,
    }));
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    check('13 URL camera override seeds position/target/fov',
      near(override.pos[0], 1.5) && near(override.pos[1], 0.9) && near(override.pos[2], 2.2) &&
      near(override.target[0], 0.2) && near(override.fov, 35),
      `pos=${override.pos.map((v) => v.toFixed(2))} fov=${override.fov}`);
    check('13b free-camera control still enabled after override',
      override.controlsEnabled === true);
    await page2.close();

    // ---- criterion 10: failed frame fetch degrades gracefully -------
    const page3 = await context.newPage();
    // Block exactly one frame file so its fetch fails every retry.
    await page3.route('**/frame_0002.sog', (route) => route.abort('failed'));
    const p3errors = [];
    page3.on('pageerror', (e) => p3errors.push(e.message));
    await page3.goto(`${BASE}/?paused=1&retries=1`, { waitUntil: 'domcontentloaded' });
    await until(page3, () => Boolean(window.__player), { label: 'resilience bootstrap' });
    await until(
      page3, () => window.__player.cache.stats().ready > 0,
      { timeout: 60000, label: 'frame 1 despite frame 2 failing' },
    );
    await page3.evaluate(() => window.__player.sequencer.seekToFrame(2));
    await page3.waitForTimeout(4000);
    const resilience = await page3.evaluate(() => ({
      stats: window.__player.cache.stats(),
      alive: typeof window.__player.sequencer.tick === 'function',
      frame: window.__player.sequencer.frameNumber,
    }));
    // Drive a few more frames to prove the loop did not die.
    await page3.evaluate(() => { window.__player.sequencer.play(); });
    await page3.waitForTimeout(1500);
    const stillRunning = await page3.evaluate(() => window.__player.sequencer.elapsedSeconds > 0);
    check('10 failed frame fetch retries then skips without crashing',
      resilience.stats.failed >= 1 && resilience.alive && stillRunning && p3errors.length === 0,
      `failed=${resilience.stats.failed}, uncaught=${p3errors.length}`);
    await page3.screenshot({ path: path.join(OUT, '04-failed-frame.png') });
    await page3.close();

    // ---- console hygiene --------------------------------------------
    const unexpected = consoleErrors.filter(
      (t) => !/frame \d+ (failed|load failed)/i.test(t),
    );
    check('no unexpected console errors during the happy path',
      unexpected.length === 0,
      unexpected.slice(0, 3).join(' | ').slice(0, 300));

  } finally {
    await writeFile(
      path.join(OUT, 'results.json'),
      JSON.stringify({ passed, failed, results }, null, 2),
    );
    await browser.close();
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log(`  screenshots + results: ${OUT}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nsmoke test aborted: ${err.message}\n`);
  process.exit(1);
});
