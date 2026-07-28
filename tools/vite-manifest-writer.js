/**
 * vite-manifest-writer — DEV-ONLY endpoint that lets the player persist
 * display settings back into a sequence's manifest.json.
 *
 * A published static site obviously cannot write to disk, so the player falls
 * back to copying JSON to the clipboard when this endpoint is absent. During
 * local iteration, though, it means the Flip / Save Camera / background
 * controls actually stick instead of being lost on reload.
 *
 * Only whitelisted, presentation-level fields are writable. Fields that
 * describe what is physically on disk (frames[], frameCount, encode.*) are
 * never touched, so the manifest cannot be made to disagree with the .sog
 * files beside it.
 *
 * Not registered in production builds — `apply: 'serve'` keeps it out.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Presentation-only fields the browser may change. */
const WRITABLE = new Set(['display', 'camera', 'project', 'temporal.playbackFps', 'audio']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reject anything that could escape the data directory. */
function safeSequenceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

export function manifestWriter({ dataDir = 'data' } = {}) {
  return {
    name: 'manifest-writer',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;

      server.middlewares.use('/__manifest', async (req, res) => {
        const send = (code, body) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (req.method === 'GET') {
          // Presence probe: lets the player know saving is available.
          return send(200, { ok: true, writable: true });
        }
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

          const seq = safeSequenceId(body.sequence);
          if (!seq) return send(400, { error: 'invalid or missing sequence id' });
          if (!isPlainObject(body.patch)) return send(400, { error: 'patch must be an object' });

          const rejected = Object.keys(body.patch).filter((k) => !WRITABLE.has(k));
          if (rejected.length) {
            return send(400, {
              error: `these fields are not writable from the browser: ${rejected.join(', ')}`,
            });
          }

          const file = path.resolve(root, dataDir, seq, 'manifest.json');
          const base = path.resolve(root, dataDir);
          if (!file.startsWith(base + path.sep)) {
            return send(400, { error: 'path escapes the data directory' });
          }

          const current = JSON.parse(await fs.readFile(file, 'utf8'));

          // Shallow-merge per top-level key so a partial `display` patch does
          // not wipe sibling fields.
          for (const [key, value] of Object.entries(body.patch)) {
            if (isPlainObject(value) && isPlainObject(current[key])) {
              current[key] = { ...current[key], ...value };
            } else {
              current[key] = value;
            }
          }

          await fs.writeFile(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
          server.config.logger.info(
            `  manifest-writer: updated ${seq} (${Object.keys(body.patch).join(', ')})`,
          );
          return send(200, { ok: true, sequence: seq, written: Object.keys(body.patch) });
        } catch (err) {
          return send(500, { error: String(err?.message ?? err) });
        }
      });
    },
  };
}

export default manifestWriter;
