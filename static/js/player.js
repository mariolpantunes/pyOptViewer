// Timeline of buffered frames played at a fixed epoch rate.
//
// `t` is a fractional frame index: 3.4 means 40% of the way from epoch 3 to 4.
// Renderers get the two bracketing frames and an eased fraction, so motion is
// continuous regardless of how (or how fast) the frames arrived.

const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

export class Player {
  constructor() {
    this.frames = [];
    this.t = 0;
    this.playing = false;
    this.speed = 4; // epochs per second
    this.smooth = true;
    this.streaming = false; // more frames may still arrive
    this.listeners = new Set();
    this._last = null;
    this._dirty = true;
    requestAnimationFrame((ts) => this._tick(ts));
  }

  onUpdate(fn) {
    this.listeners.add(fn);
  }

  load(frames, { streaming = false } = {}) {
    this.frames = frames;
    this.streaming = streaming;
    this.t = 0;
    this._dirty = true;
  }

  push(frame) {
    this.frames.push(frame);
    this._dirty = true;
  }

  get last() {
    return Math.max(0, this.frames.length - 1);
  }

  play() {
    if (this.t >= this.last && !this.streaming) this.t = 0;
    this.playing = true;
    this._dirty = true;
  }

  pause() {
    this.playing = false;
    this._dirty = true;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    this.t = Math.min(Math.max(0, t), this.last);
    this._dirty = true;
  }

  step(delta) {
    this.pause();
    this.seek(Math.round(this.t) + delta);
  }

  invalidate() {
    this._dirty = true;
  }

  // State handed to renderers for the current instant.
  state() {
    const i = Math.floor(this.t);
    const a = this.frames[i];
    const b = this.frames[Math.min(i + 1, this.last)] ?? a;
    const raw = this.t - i;
    const u = this.smooth ? easeInOut(raw) : 0;
    return { t: this.t, index: i, a, b, u, frames: this.frames };
  }

  _tick(ts) {
    const dt = this._last === null ? 0 : Math.min((ts - this._last) / 1000, 0.1);
    this._last = ts;
    if (this.playing && this.frames.length > 1) {
      const next = this.t + dt * this.speed;
      if (next >= this.last) {
        this.t = this.last;
        // Keep "playing" while streaming so new frames are picked up as they land.
        if (!this.streaming) this.playing = false;
      } else {
        this.t = next; // with smooth off, state() snaps to the lower frame
      }
      this._dirty = true;
    }
    // Scheduled first and listeners isolated: one failing view must not stop playback.
    requestAnimationFrame((t) => this._tick(t));
    if (this._dirty && this.frames.length) {
      this._dirty = false;
      const s = this.state();
      for (const fn of this.listeners) {
        try {
          fn(s);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }
}
