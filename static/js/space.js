// 2D search-space view on a plain canvas.
//
// The landscape (heatmap + contours) is rasterised once per function/size into
// an offscreen canvas; each animation frame only blits it and draws the
// population on top, which is what keeps playback at display refresh rate.

import { viridis, normaliser } from "./colormap.js";

const COLORS = {
  pop: "#d08770",
  popStroke: "#2e3440",
  trail: "236, 239, 244",
  improved: "163, 190, 140",
  best: "#ebcb8b",
  optimum: "#eceff4",
  visited: "rgba(236, 239, 244, 0.35)",
  axis: "#d8dee9",
};
const TRAIL_LEN = 8;
const PAD = 30; // CSS px reserved for axis labels

export class SpaceView {
  constructor(canvas, onHover) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onHover = onHover;
    this.surface = null;
    this.opts = { log: true, contours: true, trails: true, visited: false };
    this.bg = document.createElement("canvas");
    this.visited = document.createElement("canvas");
    this.visitedUpTo = 0;
    this.lastState = null;

    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    canvas.addEventListener("mousemove", (e) => this._hover(e));
    canvas.addEventListener("mouseleave", () => this.onHover(null));
  }

  setSurface(surface) {
    this.surface = surface;
    this._rebuild();
  }

  setOptions(opts) {
    const bgChanged = opts.log !== this.opts.log || opts.contours !== this.opts.contours;
    this.opts = { ...this.opts, ...opts };
    if (bgChanged) this._rebuild();
    else this._redraw();
  }

  resetVisited() {
    this.visitedUpTo = 0;
    const c = this.visited.getContext("2d");
    c.clearRect(0, 0, this.visited.width, this.visited.height);
  }

  render(state) {
    this.lastState = state;
    this._redraw();
  }

  // --- geometry ------------------------------------------------------------------

  _resize() {
    const wrap = this.canvas.parentElement;
    const size = Math.max(200, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.size = size;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.plot = { x: PAD * dpr, y: 6 * dpr, w: (size - PAD - 6) * dpr, h: (size - PAD - 6) * dpr };
    this._rebuild();
  }

  _toPx([x, y]) {
    const [lo, hi] = this._bounds();
    const p = this.plot;
    return [p.x + ((x - lo) / (hi - lo)) * p.w, p.y + (1 - (y - lo) / (hi - lo)) * p.h];
  }

  _bounds() {
    const xs = this.surface?.x ?? [-5, 5];
    return [xs[0], xs[xs.length - 1]];
  }

  // Bilinear interpolation of the surface grid at world coordinates.
  _sample(x, y) {
    const s = this.surface;
    const n = s.x.length;
    const [lo, hi] = this._bounds();
    const gx = Math.min(Math.max(((x - lo) / (hi - lo)) * (n - 1), 0), n - 1.0001);
    const gy = Math.min(Math.max(((y - lo) / (hi - lo)) * (n - 1), 0), n - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = gx - i, fy = gy - j;
    const z = s.z;
    return (
      z[j][i] * (1 - fx) * (1 - fy) + z[j][i + 1] * fx * (1 - fy) +
      z[j + 1][i] * (1 - fx) * fy + z[j + 1][i + 1] * fx * fy
    );
  }

  // --- static layers ---------------------------------------------------------------

  _rebuild() {
    if (!this.surface || !this.plot) return;
    const { w, h } = this.plot;
    const W = Math.round(w), H = Math.round(h);
    this.bg.width = this.visited.width = this.canvas.width;
    this.bg.height = this.visited.height = this.canvas.height;
    this.visitedUpTo = 0;

    const norm = normaliser(this.surface.z_min, this.surface.z_max, this.opts.log);
    const [lo, hi] = this._bounds();
    const values = new Float32Array(W * H);
    for (let py = 0; py < H; py++) {
      const y = hi - ((py + 0.5) / H) * (hi - lo);
      for (let px = 0; px < W; px++) {
        const x = lo + ((px + 0.5) / W) * (hi - lo);
        values[py * W + px] = norm(this._sample(x, y));
      }
    }

    const img = new ImageData(W, H);
    const levels = 16;
    for (let k = 0; k < W * H; k++) {
      let [r, g, b] = viridis(values[k]);
      if (this.opts.contours) {
        const lv = Math.floor(values[k] * levels);
        const px = k % W;
        const edge =
          (px > 0 && Math.floor(values[k - 1] * levels) !== lv) ||
          (k >= W && Math.floor(values[k - W] * levels) !== lv);
        if (edge) (r *= 0.55), (g *= 0.55), (b *= 0.55);
      }
      img.data[4 * k] = r;
      img.data[4 * k + 1] = g;
      img.data[4 * k + 2] = b;
      img.data[4 * k + 3] = 255;
    }

    const c = this.bg.getContext("2d");
    c.fillStyle = "#3b4252";
    c.fillRect(0, 0, this.bg.width, this.bg.height);
    c.putImageData(img, Math.round(this.plot.x), Math.round(this.plot.y));
    this._drawAxes(c);
    this._redraw();
  }

  _drawAxes(c) {
    const dpr = this.dpr;
    const [lo, hi] = this._bounds();
    c.fillStyle = COLORS.axis;
    c.font = `${11 * dpr}px system-ui, sans-serif`;
    for (let v = Math.ceil(lo); v <= hi; v++) {
      const [px, py] = this._toPx([v, v]);
      c.textAlign = "center";
      c.textBaseline = "top";
      c.fillText(String(v), px, this.plot.y + this.plot.h + 5 * dpr);
      c.textAlign = "right";
      c.textBaseline = "middle";
      c.fillText(String(v), this.plot.x - 6 * dpr, py);
    }
  }

  _updateVisited(state) {
    if (state.index + 1 < this.visitedUpTo) this.resetVisited();
    const c = this.visited.getContext("2d");
    c.fillStyle = COLORS.visited;
    const r = 1.3 * this.dpr;
    for (let k = this.visitedUpTo; k <= state.index; k++) {
      for (const p of state.frames[k].pop) {
        const [x, y] = this._toPx(p);
        c.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
    this.visitedUpTo = state.index + 1;
  }

  // --- per-frame drawing ------------------------------------------------------------

  _redraw() {
    const ctx = this.ctx;
    const s = this.lastState;
    if (!this.surface || !this.plot) return;
    ctx.drawImage(this.bg, 0, 0);
    if (s?.a) {
      if (this.opts.visited) {
        this._updateVisited(s);
        ctx.drawImage(this.visited, 0, 0);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.plot.x, this.plot.y, this.plot.w, this.plot.h);
      ctx.clip();
      const pos = this._positions(s);
      if (this.opts.trails) this._drawTrails(s, pos);
      this._drawImproved(s, pos);
      this._drawPopulation(pos);
      this._drawBest(s);
      ctx.restore();
    }
    this._drawOptima();
  }

  _positions({ a, b, u }) {
    const out = new Array(b.pop.length);
    for (let i = 0; i < b.pop.length; i++) {
      const pb = b.pop[i];
      const pa = a.pop[i] ?? pb;
      out[i] = [pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u];
    }
    // Before the transition starts, show the current frame as-is.
    return u === 0 ? a.pop.map((p) => [p[0], p[1]]) : out;
  }

  _drawTrails({ frames, index }, pos) {
    const ctx = this.ctx;
    ctx.lineWidth = 1.2 * this.dpr;
    ctx.lineCap = "round";
    const start = Math.max(0, index - TRAIL_LEN + 1);
    const n = pos.length;
    for (let k = start; k <= index; k++) {
      const from = frames[k];
      const to = k < index ? frames[k + 1] : null;
      const alpha = ((k - start + 1) / (index - start + 2)) * 0.55;
      ctx.strokeStyle = `rgba(${COLORS.trail}, ${alpha})`;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const p0 = from.pop[i];
        const p1 = to ? to.pop[i] : pos[i];
        if (!p0 || !p1) continue;
        const [x0, y0] = this._toPx(p0);
        const [x1, y1] = this._toPx(p1);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    }
  }

  // Halo on individuals whose fitness improved in the epoch being entered.
  _drawImproved({ frames, index, u }, pos) {
    const improvedAt = (k) => {
      const cur = frames[k], prev = frames[k - 1];
      if (!cur || !prev) return null;
      return cur.scores.map((s, i) => prev.scores[i] !== undefined && s < prev.scores[i] - 1e-12);
    };
    const now = improvedAt(index);
    const next = u > 0 ? improvedAt(index + 1) : null;
    const ctx = this.ctx;
    const r = 7 * this.dpr;
    for (let i = 0; i < pos.length; i++) {
      const alpha = (now?.[i] ? 1 - u : 0) + (next?.[i] ? u : 0);
      if (alpha <= 0.02) continue;
      const [x, y] = this._toPx(pos[i]);
      ctx.fillStyle = `rgba(${COLORS.improved}, ${0.55 * alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  _drawPopulation(pos) {
    const ctx = this.ctx;
    const r = 3.6 * this.dpr;
    ctx.fillStyle = COLORS.pop;
    ctx.strokeStyle = COLORS.popStroke;
    ctx.lineWidth = 1.2 * this.dpr;
    ctx.beginPath();
    for (const p of pos) {
      const [x, y] = this._toPx(p);
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
    ctx.fill();
    ctx.stroke();
  }

  _drawBest({ a, b, u }) {
    const pa = a.best_pos, pb = b.best_pos ?? pa;
    if (!pa) return;
    const p = [pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u];
    const [x, y] = this._toPx(p);
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.strokeStyle = COLORS.best;
    ctx.lineWidth = 2 * d;
    ctx.beginPath();
    ctx.arc(x, y, 8 * d, 0, 2 * Math.PI);
    ctx.moveTo(x - 13 * d, y); ctx.lineTo(x - 4 * d, y);
    ctx.moveTo(x + 4 * d, y); ctx.lineTo(x + 13 * d, y);
    ctx.moveTo(x, y - 13 * d); ctx.lineTo(x, y - 4 * d);
    ctx.moveTo(x, y + 4 * d); ctx.lineTo(x, y + 13 * d);
    ctx.stroke();
  }

  _drawOptima() {
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.strokeStyle = COLORS.optimum;
    ctx.lineWidth = 2 * d;
    for (const o of this.surface.optima) {
      const [x, y] = this._toPx(o);
      const r = 5 * d;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r);
      ctx.stroke();
    }
  }

  _hover(e) {
    if (!this.surface) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * this.dpr;
    const py = (e.clientY - rect.top) * this.dpr;
    const p = this.plot;
    const [lo, hi] = this._bounds();
    const x = lo + ((px - p.x) / p.w) * (hi - lo);
    const y = hi - ((py - p.y) / p.h) * (hi - lo);
    if (x < lo || x > hi || y < lo || y > hi) return this.onHover(null);
    this.onHover({ x, y, f: this._sample(x, y) });
  }
}
