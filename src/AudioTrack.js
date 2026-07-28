/**
 * AudioTrack.js — optional audio synced to the Sequencer clock.
 *
 * v1 ships this DORMANT. The reference build's manifest has no `audio` block,
 * and with no block this module must be indistinguishable from not existing:
 *   - no fetch is issued
 *   - no UI chrome appears (Timeline checks `.available`)
 *   - nothing is logged
 * That no-regression property is acceptance criterion 14, so the "absent"
 * path below deliberately does nothing at all rather than warning.
 *
 * When a block IS present, drop the file next to the frames and add:
 *   "audio": { "file": "narration.mp3", "offsetSeconds": 0, "loop": true }
 * No code change is required.
 */

/** How far audio may drift from the frame clock before we hard-correct, in
 *  seconds. Below this, small differences are left alone — repeatedly setting
 *  currentTime causes audible stutter, which is worse than a few ms of skew. */
const RESYNC_THRESHOLD = 0.25;

export class AudioTrack {
  /**
   * @param {object} opts
   * @param {object|null} opts.manifestAudio  manifest.audio, or null/undefined
   * @param {string} opts.baseUrl             same resolver the frames use
   * @param {import('./Sequencer.js').Sequencer} opts.sequencer
   * @param {boolean} [opts.defaultMuted]
   * @param {number}  [opts.defaultVolume]
   */
  constructor({ manifestAudio, baseUrl, sequencer, defaultMuted = true, defaultVolume = 1 }) {
    this.sequencer = sequencer;
    this.available = false;
    this.el = null;
    this.muted = defaultMuted;
    this.volume = defaultVolume;
    this.offsetSeconds = 0;
    this.loop = true;
    this._failed = false;
    this._needsGesture = false;

    // The dormant path: no manifest.audio -> do absolutely nothing.
    if (!manifestAudio || !manifestAudio.file) return;

    this.offsetSeconds = Number(manifestAudio.offsetSeconds) || 0;
    this.loop = manifestAudio.loop !== false;

    const url = new URL(manifestAudio.file, baseUrl).href;
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    el.loop = false; // looping is driven by the Sequencer, not the element
    el.muted = this.muted;
    el.volume = this.volume;

    el.addEventListener('error', () => {
      // Missing/failed audio must never block frame playback.
      this._failed = true;
      this.available = false;
      console.warn(`[AudioTrack] failed to load ${url}; continuing silently.`);
    });

    this.el = el;
    this.available = true;
    this._bind();
  }

  _bind() {
    const seq = this.sequencer;
    seq.on('playstatechange', (playing) => (playing ? this._play() : this._pause()));
    seq.on('seek', () => this.syncNow());
    seq.on('fpschange', () => this.syncNow());
    seq.on('ended', () => this._pause());
  }

  /** Wall-clock position the audio should be at for the current frame. */
  get targetTime() {
    return Math.max(0, this.sequencer.elapsedSeconds + this.offsetSeconds);
  }

  _play() {
    if (!this.available || this._failed) return;
    this.syncNow();
    const p = this.el.play();
    if (p?.catch) {
      p.catch(() => {
        // Autoplay-with-sound is blocked until a user gesture. Surface the
        // affordance rather than failing silently.
        this._needsGesture = true;
        this.onNeedsGesture?.();
      });
    }
  }

  _pause() {
    if (!this.available || this._failed) return;
    this.el.pause();
  }

  /** Called after a user gesture to satisfy autoplay policy. */
  async unlock() {
    if (!this.available || this._failed) return;
    try {
      await this.el.play();
      this._needsGesture = false;
      if (!this.sequencer.playing) this.el.pause();
    } catch {
      /* still blocked; the affordance stays up */
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.el) this.el.muted = this.muted;
    if (!this.muted && this._needsGesture) this.unlock();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, Number(v) || 0));
    if (this.el) this.el.volume = this.volume;
  }

  /** Hard-seek the element to the sequencer's position (scrub / loop wrap). */
  syncNow() {
    if (!this.available || this._failed) return;
    const t = this.targetTime;
    const duration = this.el.duration;
    if (Number.isFinite(duration) && duration > 0 && t > duration) {
      // Animation outlasts the track. `loop: true` wraps the audio with the
      // sequence; otherwise the track simply ends and playback continues silent.
      this.el.currentTime = this.loop ? t % duration : duration;
      return;
    }
    try {
      this.el.currentTime = t;
    } catch {
      /* not seekable yet; the next tick corrects it */
    }
  }

  /** Called once per rendered frame; corrects accumulated drift only. */
  tick() {
    if (!this.available || this._failed || !this.sequencer.playing) return;
    if (this.el.readyState < 2) return;
    const drift = Math.abs(this.el.currentTime - this.targetTime);
    if (drift > RESYNC_THRESHOLD) this.syncNow();
  }

  dispose() {
    if (!this.el) return;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el = null;
    this.available = false;
  }
}
