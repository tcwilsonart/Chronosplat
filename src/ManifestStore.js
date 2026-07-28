/**
 * ManifestStore.js — persist presentation settings back to a sequence manifest.
 *
 * Two paths, chosen automatically:
 *
 *   dev  — POST to the Vite dev-server endpoint (tools/vite-manifest-writer.js),
 *          which writes data/<seq>/manifest.json on disk. Changes survive a
 *          reload, which is the whole point when you are dialling in
 *          orientation, framing, and background for a new sequence.
 *
 *   prod — a published static site cannot write files, so the JSON is copied
 *          to the clipboard for pasting into the manifest by hand.
 *
 * Only presentation fields are ever sent; the server enforces the same
 * whitelist, so nothing here can make a manifest disagree with the .sog files
 * beside it.
 */

const ENDPOINT = '/__manifest';

export class ManifestStore {
  constructor() {
    /** null = not probed yet, true/false = endpoint availability. */
    this._writable = null;
    this.onStatus = null; // (message, kind) => void
  }

  /** Is server-side saving available? Probed once, then cached. */
  async writable() {
    if (this._writable !== null) return this._writable;
    try {
      const res = await fetch(ENDPOINT, { method: 'GET' });
      this._writable = res.ok && Boolean((await res.json())?.writable);
    } catch {
      this._writable = false;
    }
    return this._writable;
  }

  /**
   * Persist a patch of presentation fields.
   * @param {string} sequenceId folder name under data/
   * @param {object} patch      e.g. { display: { flipX: false } }
   * @returns {Promise<'saved'|'clipboard'|'failed'>}
   */
  async save(sequenceId, patch) {
    if (await this.writable()) {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequence: sequenceId, patch }),
        });
        if (res.ok) {
          this.onStatus?.(`Saved to ${sequenceId}/manifest.json`, 'ok');
          return 'saved';
        }
        const body = await res.json().catch(() => ({}));
        console.warn('[ManifestStore] server refused the patch:', body.error ?? res.status);
      } catch (err) {
        console.warn('[ManifestStore] save failed, falling back to clipboard:', err);
      }
    }
    return this._toClipboard(sequenceId, patch);
  }

  async _toClipboard(sequenceId, patch) {
    const text = JSON.stringify(patch, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.onStatus?.(
        `Copied to clipboard — paste into ${sequenceId}/manifest.json`, 'ok',
      );
      console.info(`[chronosplat] paste into data/${sequenceId}/manifest.json:\n${text}`);
      return 'clipboard';
    } catch {
      // Clipboard needs a user gesture and a secure context; neither is
      // guaranteed. The console copy is always available as a last resort.
      this.onStatus?.('Could not copy — see the browser console', 'warn');
      console.info(`[chronosplat] paste into data/${sequenceId}/manifest.json:\n${text}`);
      return 'failed';
    }
  }
}
