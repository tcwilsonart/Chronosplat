/**
 * Timeline.js — HTML/CSS overlay transport controls.
 *
 * Reads state from the Sequencer and emits intent back to it. Deliberately
 * framework-free: a handful of DOM nodes and listeners.
 *
 * Everything data-dependent is derived from the Sequencer, which got it from
 * the manifest: the slider range, the label denominator, and the zero-padding
 * width all come from `frameCount`. Nothing here assumes 59 frames or 24 fps.
 */

export class Timeline {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount
   * @param {import('./Sequencer.js').Sequencer} opts.sequencer
   * @param {import('./AudioTrack.js').AudioTrack|null} [opts.audio]
   * @param {() => void} [opts.onToggleFlip]
   * @param {() => void} [opts.onResetCamera]
   * @param {() => void} [opts.onSaveCamera]
   */
  constructor({ mount, sequencer, audio = null,
                onRequestPlay = null, onCancelPlay = null,
                sequences = null, activeSequenceId = null,
                onSelectSequence = null, onToggleFlip = null,
                onResetCamera = null, onSaveScene = null,
                onToggleStats = null, onPreviewBackground = null,
                background = null }) {
    this.onToggleFlip = onToggleFlip;
    this.onResetCamera = onResetCamera;
    this.onSaveScene = onSaveScene;
    this.onToggleStats = onToggleStats;
    this.onPreviewBackground = onPreviewBackground;
    this.background = background;
    this.sequencer = sequencer;
    this.audio = audio;
    // Library dropdown. Only rendered when the index lists more than one
    // sequence — a single-sequence deployment gets no redundant chrome.
    this.sequences = Array.isArray(sequences) && sequences.length > 1 ? sequences : null;
    this.activeSequenceId = activeSequenceId;
    this.onSelectSequence = onSelectSequence;
    // Play goes through the host so it can prebuffer first; falls back to a
    // direct play() when no handler is supplied.
    this.onRequestPlay = onRequestPlay;
    this.onCancelPlay = onCancelPlay;

    // Padding width follows the frame count: 59 -> 2, 400 -> 3, 1200 -> 4.
    this.padWidth = String(sequencer.frameCount).length;

    this.root = document.createElement('div');
    this.root.className = 'timeline';
    this.root.innerHTML = this._template();
    mount.appendChild(this.root);

    this.$play = this.root.querySelector('[data-play]');
    this.$slider = this.root.querySelector('[data-slider]');
    this.$frameLabel = this.root.querySelector('[data-frame-label]');
    this.$timeLabel = this.root.querySelector('[data-time-label]');
    this.$loop = this.root.querySelector('[data-loop]');
    this.$fps = this.root.querySelector('[data-fps]');
    this.$mode = this.root.querySelector('[data-mode]');
    this.$sequence = this.root.querySelector('[data-sequence]');
    this.$flip = this.root.querySelector('[data-flip]');
    this.$reset = this.root.querySelector('[data-reset]');
    this.$saveScene = this.root.querySelector('[data-save-scene]');
    this.$bg = this.root.querySelector('[data-bg]');
    this.$stats = this.root.querySelector('[data-stats]');
    this.$audio = this.root.querySelector('[data-audio-group]');
    this.$mute = this.root.querySelector('[data-mute]');
    this.$volume = this.root.querySelector('[data-volume]');

    this._wasPlayingBeforeScrub = false;
    this._bind();
    this._syncAll();
  }

  _template() {
    const n = this.sequencer.frameCount;
    const seqPicker = this.sequences ? `
      <label class="tl-field tl-seq" title="Choose a sequence">
        <select data-sequence aria-label="Sequence">
          ${this.sequences.map((s) => {
            const sel = s.id === this.activeSequenceId ? ' selected' : '';
            const mib = s.bytes ? ` — ${(s.bytes / 1048576).toFixed(0)} MB` : '';
            return `<option value="${escapeAttr(s.id)}"${sel}>` +
                   `${escapeHtml(s.name ?? s.id)} (${s.frameCount}f${mib})</option>`;
          }).join('')}
        </select>
      </label>` : '';

    return `
      ${seqPicker}
      <button class="tl-btn tl-play" data-play aria-label="Play/pause"></button>

      <input class="tl-slider" data-slider type="range"
             min="1" max="${n}" step="1" value="${this.sequencer.frameNumber}"
             aria-label="Timeline scrubber" />

      <span class="tl-readout">
        <span class="tl-frame" data-frame-label></span>
        <span class="tl-time" data-time-label></span>
      </span>

      <label class="tl-toggle" title="Loop playback">
        <input type="checkbox" data-loop /><span>Loop</span>
      </label>

      <label class="tl-field" title="Playback frames per second">
        <input type="number" data-fps min="0.1" max="240" step="0.1" /><span>fps</span>
      </label>

      <label class="tl-field tl-mode" title="everyFrame: show every frame, slower than authored fps when decode cannot keep up.&#10;realtime: follow the wall clock and drop frames that are not decoded in time.">
        <select data-mode>
          <option value="everyFrame">every frame</option>
          <option value="realtime">realtime</option>
        </select>
      </label>

      <span class="tl-group">
        <button class="tl-btn tl-text" data-flip title="Flip 180° about X (preview only — click Save Scene to keep it)">Flip</button>
        <button class="tl-btn tl-text" data-reset title="Reset the camera to this sequence's saved view (or auto-frame)">Reset</button>
        <label class="tl-swatch" title="Background colour for this sequence (preview only — click Save Scene to keep it)">
          <input type="color" data-bg />
        </label>
        <button class="tl-btn tl-text" data-stats title="Toggle the stats overlay (S)">Stats</button>
      </span>

      <span class="tl-audio" data-audio-group hidden>
        <button class="tl-btn tl-text" data-mute aria-label="Mute"></button>
        <input class="tl-volume" data-volume type="range" min="0" max="1" step="0.01"
               aria-label="Volume" />
      </span>

      <button class="tl-btn tl-text tl-save" data-save-scene
              title="Save the current view for this sequence — camera, orientation and background — into its manifest.json">Save Scene</button>
    `;
  }

  _bind() {
    const seq = this.sequencer;

    this.$play.addEventListener('click', () => this._togglePlay());

    if (this.$sequence) {
      this.$sequence.addEventListener('change', () => {
        this.onSelectSequence?.(this.$sequence.value);
      });
    }

    this.$mode.value = seq.mode;
    this.$mode.addEventListener('change', () => seq.setMode(this.$mode.value));
    seq.on('modechange', () => { this.$mode.value = seq.mode; });
    seq.on('stallchange', (stalled) => this.setLoadingFrame(stalled));

    // Scrubbing while playing re-seeks and resumes; while paused it shows the
    // scrubbed frame immediately.
    this.$slider.addEventListener('pointerdown', () => {
      this._wasPlayingBeforeScrub = seq.playing;
      this.onCancelPlay?.();
      if (seq.playing) seq.pause();
    });
    const endScrub = () => {
      if (this._wasPlayingBeforeScrub) {
        this._wasPlayingBeforeScrub = false;
        this._requestPlay();
      }
    };
    this.$slider.addEventListener('pointerup', endScrub);
    this.$slider.addEventListener('pointercancel', endScrub);
    this.$slider.addEventListener('input', () => {
      seq.seekToFrame(Number(this.$slider.value));
    });
    // Keyboard scrubbing needs no play/pause dance.
    this.$slider.addEventListener('keydown', (e) => e.stopPropagation());

    this.$loop.addEventListener('change', () => seq.setLoop(this.$loop.checked));

    this.$fps.addEventListener('change', () => {
      const v = Number(this.$fps.value);
      if (Number.isFinite(v) && v > 0) seq.fps = v;
      else this.$fps.value = String(seq.fps);
    });

    this.$flip.addEventListener('click', () => this.onToggleFlip?.());
    this.$reset.addEventListener('click', () => this.onResetCamera?.());
    this.$saveScene.addEventListener('click', () => this.onSaveScene?.());
    this.$stats.addEventListener('click', () => this.onToggleStats?.());

    if (this.background) this.$bg.value = normalizeHex(this.background);
    // Both events preview live; persisting is Save Scene's job.
    this.$bg.addEventListener('input', () => this.onPreviewBackground?.(this.$bg.value));
    this.$bg.addEventListener('change', () => this.onPreviewBackground?.(this.$bg.value));

    seq.on('framechange', () => this._syncFrame());
    seq.on('seek', () => this._syncFrame());
    seq.on('playstatechange', () => this._syncPlay());
    seq.on('fpschange', () => this._syncFps());
    seq.on('loopchange', () => this._syncLoop());

    if (this.audio?.available) {
      this.$audio.hidden = false;
      this.$volume.value = String(this.audio.volume);
      this.$mute.addEventListener('click', () => {
        this.audio.setMuted(!this.audio.muted);
        this._syncAudio();
      });
      this.$volume.addEventListener('input', () => {
        this.audio.setVolume(Number(this.$volume.value));
        this._syncAudio();
      });
      this._syncAudio();
    }

    // Global shortcuts: space toggles, arrows step, L loops.
    this._onKey = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this._togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          seq.seekToFrame(seq.frameNumber + (e.shiftKey ? 10 : 1));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seq.seekToFrame(seq.frameNumber - (e.shiftKey ? 10 : 1));
          break;
        case 'KeyL':
          seq.setLoop(!seq.loop);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  _requestPlay() {
    if (this.onRequestPlay) this.onRequestPlay();
    else this.sequencer.play();
  }

  _togglePlay() {
    if (this.sequencer.playing) {
      this.onCancelPlay?.();
      this.sequencer.pause();
    } else {
      this._requestPlay();
    }
  }

  /** Reflect the current orientation on the Flip button. */
  setFlipActive(active) {
    this.$flip.classList.toggle('is-active', Boolean(active));
  }

  /** Reflect stats-overlay visibility on the Stats button. */
  setStatsActive(active) {
    this.$stats.classList.toggle('is-active', Boolean(active));
  }

  /** Update the colour swatch without re-firing change events. */
  setBackground(color) {
    if (color) this.$bg.value = normalizeHex(color);
  }

  /** Show a per-frame loading state when the active frame is not resident. */
  setLoadingFrame(isLoading) {
    this.root.classList.toggle('is-loading-frame', Boolean(isLoading));
  }

  _syncAll() {
    this._syncPlay();
    this._syncFrame();
    this._syncFps();
    this._syncLoop();
  }

  _syncPlay() {
    const playing = this.sequencer.playing;
    this.$play.classList.toggle('is-playing', playing);
    this.$play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  _syncFrame() {
    const seq = this.sequencer;
    const n = seq.frameNumber;
    if (document.activeElement !== this.$slider) this.$slider.value = String(n);
    this.$frameLabel.textContent =
      `${String(n).padStart(this.padWidth, '0')} / ${seq.frameCount}`;
    this.$timeLabel.textContent =
      `${fmtTime(seq.elapsedSeconds)} / ${fmtTime(seq.durationSeconds)}`;
  }

  _syncFps() {
    if (document.activeElement !== this.$fps) {
      this.$fps.value = String(round(this.sequencer.fps));
    }
    this._syncFrame(); // duration depends on fps
  }

  _syncLoop() {
    this.$loop.checked = this.sequencer.loop;
  }

  _syncAudio() {
    if (!this.audio?.available) return;
    this.$mute.textContent = this.audio.muted ? 'Unmute' : 'Mute';
    this.$volume.value = String(this.audio.volume);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.root.remove();
  }
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

// Sequence names and ids come from a generated index file, but that file is
// authored from folder names on disk — escape rather than trust it.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

/** `<input type="color">` only accepts #rrggbb; coerce common CSS forms. */
function normalizeHex(color) {
  const s = String(color).trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
  }
  // Let the browser resolve named colours and rgb() via a throwaway element.
  try {
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000000';
    probe.fillStyle = s;
    const resolved = probe.fillStyle;
    if (/^#[0-9a-f]{6}$/i.test(resolved)) return resolved.toLowerCase();
  } catch { /* fall through */ }
  return '#0b0d10';
}
