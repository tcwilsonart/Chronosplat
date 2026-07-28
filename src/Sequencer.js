/**
 * Sequencer.js — owns the playback clock and the current frame index.
 *
 * Frames advance on a WALL CLOCK at the configured fps, fully decoupled
 * from render fps. Dropped render frames must not desync playback, so the
 * playhead is derived from accumulated real time rather than from a per-render
 * increment. A 200 ms render stall advances the playhead by 200 ms worth of
 * frames — it does not lose them.
 *
 * Frame numbering: internally 0-based (`index`), externally 1-based
 * (`frameNumber`) to match manifest `frames[].index` and the UI label.
 */

/** Minimal event emitter — the player needs three event types, not a library. */
class Emitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[Sequencer] listener for "${event}" threw:`, err);
      }
    }
  }
}

export class Sequencer extends Emitter {
  /**
   * @param {object}  opts
   * @param {number}  opts.frameCount  authoritative, from manifest.frameCount
   * @param {number}  opts.fps         from manifest.temporal.playbackFps
   * @param {boolean} [opts.loop]
   * @param {number}  [opts.startFrame] 1-based
   */
  constructor({ frameCount, fps, loop = true, startFrame = 1, mode = 'everyFrame' }) {
    super();
    if (!Number.isInteger(frameCount) || frameCount < 1) {
      throw new Error(`Sequencer: invalid frameCount ${frameCount}`);
    }
    this.frameCount = frameCount;
    this._fps = fps > 0 ? fps : 24;
    this.loop = loop;

    this._index = Math.min(frameCount - 1, Math.max(0, Math.round(startFrame) - 1));
    this._playing = false;
    /** Wall-clock timestamp of the last tick, ms. */
    this._lastTick = null;
    /** Fractional frame position, so slow fps does not quantise away time. */
    this._playhead = this._index;
    /** +1 forward, -1 backward. Drives FrameCache's preload direction. */
    this.direction = 1;

    /**
     * Playback mode.
     *
     *   'realtime'   — the playhead follows the wall
     *                  clock, so a frame that is not decoded in time is simply
     *                  never shown. Correct for wall-clock fidelity, but it
     *                  silently drops most frames when decode cannot keep up.
     *
     *   'everyFrame' — advance only when the next frame is actually decoded,
     *                  so EVERY frame is displayed. Playback runs slower than
     *                  the authored fps when the loader cannot sustain it, and
     *                  wall-clock duration is not preserved.
     *
     * Default is 'everyFrame' because at the reference dataset's size realtime
     * mode cannot display the content at all: a 471k-splat frame costs ~150 ms
     * to fetch and decode (~17.5 frames/sec even with 8 concurrent loads),
     * against the 42 ms budget that 24 fps demands.
     */
    this.mode = mode === 'realtime' ? 'realtime' : 'everyFrame';

    /**
     * Readiness gate for 'everyFrame' mode. Wired to FrameCache.isReady by
     * main.js. Returning false stalls the playhead instead of skipping ahead.
     */
    this.canAdvance = () => true;

    /** True while everyFrame mode is waiting on a frame to decode. */
    this.stalled = false;
  }

  // ---- state ------------------------------------------------------------

  get index() { return this._index; }
  get frameNumber() { return this._index + 1; }
  get playing() { return this._playing; }
  get fps() { return this._fps; }

  set fps(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return;
    this._fps = next;
    this.emit('fpschange', next);
  }

  /** Elapsed seconds at the current playhead — the value AudioTrack syncs to. */
  get elapsedSeconds() { return this._playhead / this._fps; }

  get durationSeconds() { return this.frameCount / this._fps; }

  // ---- transport --------------------------------------------------------

  play() {
    if (this._playing) return;
    // If parked on the last frame with looping off, restart rather than
    // sitting inert — matches what a user expects from a play button.
    if (!this.loop && this._index >= this.frameCount - 1) {
      this._playhead = 0;
      this._index = 0;
      this.emit('framechange', this._index);
    }
    this._playing = true;
    this._lastTick = null; // resync; do not credit paused time to the playhead
    this.emit('playstatechange', true);
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    this._lastTick = null;
    this.emit('playstatechange', false);
  }

  toggle() { this._playing ? this.pause() : this.play(); }

  setLoop(value) {
    this.loop = Boolean(value);
    this.emit('loopchange', this.loop);
  }

  /**
   * Jump to a 1-based frame number. Used by the scrubber and deep links.
   * Scrubbing while playing re-seeks and keeps playing.
   */
  seekToFrame(frameNumber) {
    const clamped = Math.min(this.frameCount, Math.max(1, Math.round(frameNumber)));
    const next = clamped - 1;
    if (next !== this._index) this.direction = next > this._index ? 1 : -1;
    this._index = next;
    this._playhead = next;
    this._lastTick = null; // don't let the gap since the last tick jump us on
    this.emit('framechange', this._index);
    this.emit('seek', this._index);
  }

  seekToSeconds(seconds) {
    this.seekToFrame(Math.floor(seconds * this._fps) + 1);
  }

  // ---- clock ------------------------------------------------------------

  /**
   * Advance the playhead. Call once per rendered frame with a
   * `performance.now()` timestamp; the sequencer works out how much real time
   * passed and how many frames that is worth.
   *
   * @param {number} now ms, monotonic
   * @returns {boolean} true when the active frame index changed
   */
  tick(now) {
    if (!this._playing) {
      this._lastTick = now;
      return false;
    }
    if (this._lastTick === null) {
      this._lastTick = now;
      return false;
    }

    let delta = (now - this._lastTick) / 1000;
    this._lastTick = now;

    // Guard against a huge delta from a backgrounded tab: resuming should not
    // fast-forward through hundreds of frames (and thrash the cache).
    const maxStep = 1.0;
    if (!Number.isFinite(delta) || delta < 0) return false;
    if (delta > maxStep) delta = maxStep;

    this.direction = 1;

    if (this.mode === 'everyFrame') return this._tickEveryFrame(delta);

    this._playhead += delta * this._fps;

    let ended = false;
    if (this._playhead >= this.frameCount) {
      if (this.loop) {
        // Wrap last -> first, preserving the sub-frame remainder so looping
        // does not drift.
        this._playhead %= this.frameCount;
      } else {
        this._playhead = this.frameCount - 1;
        ended = true;
      }
    }

    const next = Math.min(this.frameCount - 1, Math.floor(this._playhead));
    const changed = next !== this._index;
    if (changed) {
      this._index = next;
      this.emit('framechange', this._index);
    }
    if (ended) {
      this.pause();
      this.emit('ended');
    }
    return changed;
  }

  /**
   * 'everyFrame' clock: advance at most one frame per step, and only when that
   * frame is decoded. When it is not, the playhead is pinned at the frame
   * boundary so no time debt accumulates — otherwise a long stall would cause
   * a burst of skipped frames the moment loading caught up, which is exactly
   * what this mode exists to prevent.
   */
  _tickEveryFrame(delta) {
    this._playhead += delta * this._fps;

    // Not yet time for the next frame.
    if (this._playhead < this._index + 1) {
      if (this.stalled) {
        this.stalled = false;
        this.emit('stallchange', false);
      }
      return false;
    }

    const last = this.frameCount - 1;
    let next = this._index + 1;
    let ended = false;
    if (next > last) {
      if (this.loop) {
        next = 0;
      } else {
        this._playhead = last;
        this.pause();
        this.emit('ended');
        return false;
      }
    }

    if (!this.canAdvance(next)) {
      // Pin the clock at the boundary and report the stall.
      this._playhead = this._index + 1 - 1e-6;
      if (!this.stalled) {
        this.stalled = true;
        this.emit('stallchange', true);
      }
      return false;
    }

    if (this.stalled) {
      this.stalled = false;
      this.emit('stallchange', false);
    }

    this._index = next;
    this._playhead = next;
    this.emit('framechange', this._index);
    if (ended) this.emit('ended');
    return true;
  }

  setMode(mode) {
    const next = mode === 'realtime' ? 'realtime' : 'everyFrame';
    if (next === this.mode) return;
    this.mode = next;
    this._playhead = this._index;
    this._lastTick = null;
    if (this.stalled) {
      this.stalled = false;
      this.emit('stallchange', false);
    }
    this.emit('modechange', next);
  }

  /** Frame indices the cache should hold, nearest-first. */
  windowIndices(ahead, behind) {
    const out = [this._index];
    const dir = this.direction >= 0 ? 1 : -1;
    for (let i = 1; i <= Math.max(ahead, behind); i++) {
      if (i <= ahead) out.push(this._wrap(this._index + i * dir));
      if (i <= behind) out.push(this._wrap(this._index - i * dir));
    }
    // De-dupe: short sequences with a large window wrap onto themselves.
    return [...new Set(out)];
  }

  _wrap(i) {
    if (this.loop) return ((i % this.frameCount) + this.frameCount) % this.frameCount;
    return Math.min(this.frameCount - 1, Math.max(0, i));
  }
}
