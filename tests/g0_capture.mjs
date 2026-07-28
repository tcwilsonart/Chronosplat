/**
 * tests/g0_capture.mjs — capture evidence for the SH verification check.
 *
 * the SH check is a HUMAN visual gate. This script cannot pass it; it
 * produces the images the reviewer needs to make the call, specifically for
 * the hard half of the gate:
 *
 *   "Check this specifically by orbiting a MOVING part across at least two
 *    well-separated frames, not just by viewing frame 1 in isolation."
 *
 * For each requested frame it orbits the camera to a set of azimuths and
 * captures a shot. The reviewer then compares, for a given azimuth, how the
 * view-dependent shading on the moving part (the excavator arm/boom) behaves
 * between frames.
 *
 * WHAT TO LOOK FOR
 *   OK   — shading on the arm tracks the arm as it moves; highlights stay
 *          attached to surfaces across frames at the same viewing angle.
 *   BAD  — shading appears locked to world axes and "swims" across the arm as
 *          it rotates, i.e. SH coefficients were not rotated with the geometry
 *          during the Houdini SOP animation. This corrupts every frame
 *          identically and is the failure this gate exists to catch.
 *
 * If BAD: re-export with SH rotated, or fall back to `--sh-degree 0` and
 * record that choice in the manifest and README.
 *
 * Usage:
 *   node tests/g0_capture.mjs [--url http://localhost:5173]
 *                            [--frames 1,3] [--azimuths 4] [--radius 1.6]
 */

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
const AZIMUTHS = Number(flag('azimuths', 4));
const RADIUS_SCALE = Number(flag('radius', 1.6));
const OUT = path.resolve('docs/g0');

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('Chrome not found. Set CHROME_PATH.');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // Keep the resident window SMALL. This tool visits a handful of frames and
  // waits for each, so a big preload window buys nothing — and on a long
  // sequence it would make every frame resident at once (59 x ~20 MB ~= 1.2 GB
  // of VRAM), which is precisely what the memory bound forbids.
  await page.goto(`${BASE}/?paused=1&deepLink=0&ahead=1&behind=1`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForFunction( () => Boolean(window.__player), null, { timeout: 30000 });
  await page.waitForFunction(
     () => window.__player.cache.stats().ready > 0,
    null, { timeout: 120000 },
  );

  const meta = await page.evaluate( () => ({
    frameCount: window.__player.manifest.frames.length,
    sourceIndices: window.__player.manifest.frames.map((f) => f.sourceIndex),
    shDegree: window.__player.manifest.encode?.shDegree,
    shPresent: window.__player.manifest.source?.shPresent,
    bounds: window.__player.manifest.bounds,
  }));

  // Default to first / middle / last rather than just first+last.
  //
  // "Well-separated in index" is NOT the same as "well-separated in motion":
  // the reference Excavator sequence is static for frames 1-13, animates over
  // ~14-44, then returns to EXACTLY frame 1 by frame 59. A first+last pair is
  // therefore byte-identical and reveals nothing. Including the middle
  // guarantees at least one genuinely displaced frame. Use
  // `tools/motion_report.py` to find the moving range for other sequences and
  // pass --frames explicitly.
  const mid = Math.max(1, Math.round(meta.frameCount / 2));
  const framesArg = flag('frames', [...new Set([1, mid, meta.frameCount])].join(','));
  const frames = framesArg.split(',').map(Number).filter((n) => n >= 1 && n <= meta.frameCount);

  console.log(`\nG0 capture — SH degree ${meta.shDegree} (present: ${meta.shPresent})`);
  console.log(`  output frames ${frames.join(', ')} of ${meta.frameCount} ` +
              `(source frames ${frames.map((f) => meta.sourceIndices[f - 1]).join(', ')})`);
  console.log(`  ${AZIMUTHS} azimuths each -> ${OUT}\n`);

  if (!meta.shPresent) {
    console.log('  NOTE: source has no SH. the SH check is a quick sanity view, not a blocker.\n');
  }

  for (const frame of frames) {
    await page.evaluate((f) => window.__player.sequencer.seekToFrame(f), frame);
    // Wait for THIS frame to be resident, not just any frame.
    await page.waitForFunction(
      (f) => {
        const e = window.__player.cache.entries.get(f - 1);
        return e && e.state === 'ready';
      },
      frame, { timeout: 120000 },
    );
    await page.waitForTimeout(400);

    for (let a = 0; a < AZIMUTHS; a++) {
      const azimuth = (a / AZIMUTHS) * Math.PI * 2;
      await page.evaluate(({ azimuth, radiusScale }) => {
        const { camera, controls, manifest } = window.__player;
        const b = manifest.bounds;
        const c = b
          ? [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2)
          : [0, 0, 0];
        const size = b ? Math.hypot(...[0, 1, 2].map((i) => b.max[i] - b.min[i])) / 2 : 2;
        const r = size * radiusScale;
        const el = 0.35; // slightly above the machine, where the boom reads best
        camera.position.set(
          c[0] + r * Math.cos(el) * Math.sin(azimuth),
          c[1] + r * Math.sin(el),
          c[2] + r * Math.cos(el) * Math.cos(azimuth),
        );
        controls.target.set(c[0], c[1], c[2]);
        controls.update();
      }, { azimuth, radiusScale: RADIUS_SCALE });

      await page.waitForTimeout(350);
      const deg = Math.round((azimuth * 180) / Math.PI);
      const name = `frame${String(frame).padStart(3, '0')}_az${String(deg).padStart(3, '0')}.png`;
      await page.screenshot({ path: path.join(OUT, name) });
      console.log(`  captured ${name}`);
    }
  }

  await browser.close();
  console.log(
    `\nDone. Compare the SAME azimuth across frames and watch the moving ` +
    `boom/arm.\nSee the wiki for the pass/fail criteria.\n`,
  );
}

main().catch((err) => {
  console.error(`\ng0 capture failed: ${err.message}\n`);
  process.exit(1);
});
