import { defineConfig } from 'vite';
import { manifestWriter } from './tools/vite-manifest-writer.js';

/**
 * Static-output build.
 *
 * `base: './'` makes the built bundle path-relative so the same artifact works
 * at a GitHub Pages project URL (`/<repo>/`), at a user-site root, and from a
 * plain file server on the NAS fallback — with no rebuild per target.
 *
 * index.html lives at the repo root: Vite treats the project root as the HTML
 * entry point, and GitHub Pages needs index.html at the published root.
 *
 * `data/` is NOT bundled: the .sog frames are fetched at runtime and must stay
 * separate files so the resident-window streaming in FrameCache works .
 * The deploy workflow copies data/ into dist/ alongside the bundle.
 */
export default defineConfig({
  base: './',
  // Dev-only: lets the player's Flip / Save Camera / background controls write
  // presentation fields back into data/<seq>/manifest.json. Absent in builds,
  // where the player falls back to copying JSON to the clipboard.
  plugins: [manifestWriter({ dataDir: 'data' })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    // .sog frames are large binaries fetched at runtime; never inline assets.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    open: true,
    // data/ sits outside the module graph; Vite serves it from the project
    // root as a static file, which mirrors the production same-origin layout.
    fs: { strict: false },
  },
  preview: { port: 4173 },
});
