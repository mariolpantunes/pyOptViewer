// Plotly panels: 3D landscape / explored surface, and the convergence curve.
//
// Both are secondary views and WebGL/SVG updates are comparatively expensive,
// so they refresh on epoch changes (and at a bounded rate), never per frame.

import { VIRIDIS_SCALE } from "./colormap.js";

const THEME = {
  paper_bgcolor: "#3b4252",
  plot_bgcolor: "#3b4252",
  font: { color: "#d8dee9", size: 11 },
};
const CONFIG = { displaylogo: false, responsive: true };
const CONFIG_2D = { ...CONFIG, displayModeBar: false };

function throttle(fn, ms) {
  let last = 0, timer = null, args = null;
  return (...a) => {
    args = a;
    const wait = ms - (performance.now() - last);
    if (wait <= 0) {
      last = performance.now();
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        fn(...args);
      }, wait);
    }
  };
}

// Shared scene for both 3D plots so axes, colour range and camera line up.
function sceneLayout(surface, log, h) {
  return {
    ...THEME,
    margin: { l: 0, r: 0, t: 0, b: 0 },
    uirevision: "keep-camera",
    showlegend: false,
    scene: {
      xaxis: { title: "x", gridcolor: "#4c566a", range: [surface.x[0], surface.x.at(-1)] },
      yaxis: { title: "y", gridcolor: "#4c566a", range: [surface.y[0], surface.y.at(-1)] },
      zaxis: {
        title: log ? "log(1+f−fmin)" : "f",
        gridcolor: "#4c566a",
        range: [h(surface.z_min), h(surface.z_max)],
      },
      aspectmode: "manual",
      aspectratio: { x: 1, y: 1, z: 0.7 },
      camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } },
    },
  };
}

class Base3D {
  constructor(el) {
    this.el = el;
    this.log = true;
    this.surface = null;
    this.state = null;
    this.update = throttle((s) => this._update(s), 120);
  }

  _h(z) {
    return this.log ? Math.log1p(Math.max(z - this.surface.z_min, 0)) : z;
  }

  setSurface(surface) {
    this.surface = surface;
    this._draw();
  }

  setLog(log) {
    this.log = log;
    this._draw();
  }

  // Epoch-granular: the 3D views change only when the integer frame does.
  _changed(state, force) {
    const changed =
      force || !this.state || state.index !== this.state.index || state.frames !== this.state.frames;
    this.state = state;
    return changed && this.surface && window.Plotly && this.el.data;
  }
}

// "True Landscape": the function surface with the current population on it.
export class LandscapePlot extends Base3D {
  _draw() {
    if (!this.surface || !window.Plotly) return;
    const s = this.surface;
    const surf = {
      type: "surface",
      x: s.x,
      y: s.y,
      z: s.z.map((row) => row.map((v) => this._h(v))),
      colorscale: VIRIDIS_SCALE,
      cmin: this._h(s.z_min),
      cmax: this._h(s.z_max),
      showscale: false,
      opacity: 0.6,
      contours: { z: { show: true, usecolormap: true, project: { z: true } } },
      hoverinfo: "skip",
    };
    const pop = {
      type: "scatter3d",
      mode: "markers",
      x: [], y: [], z: [],
      marker: { size: 5, color: "#bf616a", line: { color: "#eceff4", width: 1 } },
      hoverinfo: "skip",
    };
    Plotly.react(this.el, [surf, pop], sceneLayout(s, this.log, (v) => this._h(v)), CONFIG);
    if (this.state) this._update(this.state, true);
  }

  _update(state, force = false) {
    if (!this._changed(state, force)) return;
    const f = state.a;
    Plotly.restyle(
      this.el,
      {
        x: [f.pop.map((p) => p[0])],
        y: [f.pop.map((p) => p[1])],
        z: [f.scores.map((v) => this._h(v))],
      },
      [1],
    );
  }
}

// "Explored Surface Reconstruction": a Delaunay-triangulated mesh (alphahull -1)
// over every point visited up to the current epoch, coloured by fitness.
export class ExploredMeshPlot extends Base3D {
  constructor(el) {
    super(el);
    this.reset();
  }

  // Points keyed by rounded position: revisits (common once a population has
  // converged) would give Delaunay duplicate vertices, so keep the best score.
  reset() {
    this.points = new Map();
    this.upTo = 0;
    if (this.el.data) this._draw();
  }

  _accumulate(state) {
    if (state.index + 1 < this.upTo) {
      this.points = new Map();
      this.upTo = 0;
    }
    for (let k = this.upTo; k <= state.index; k++) {
      const f = state.frames[k];
      f.pop.forEach(([x, y], i) => {
        const key = `${x.toFixed(3)},${y.toFixed(3)}`;
        const cur = this.points.get(key);
        if (!cur || f.scores[i] < cur[2]) this.points.set(key, [x, y, f.scores[i]]);
      });
    }
    this.upTo = state.index + 1;
  }

  _meshData() {
    const x = [], y = [], z = [];
    for (const [px, py, pz] of this.points.values()) {
      x.push(px);
      y.push(py);
      z.push(this._h(pz));
    }
    return { x, y, z };
  }

  _draw() {
    if (!this.surface || !window.Plotly) return;
    const s = this.surface;
    const { x, y, z } = this._meshData();
    const mesh = {
      type: "mesh3d",
      x, y, z,
      intensity: z,
      colorscale: VIRIDIS_SCALE,
      cmin: this._h(s.z_min),
      cmax: this._h(s.z_max),
      showscale: true,
      colorbar: { len: 0.8, thickness: 12 },
      opacity: 1.0,
      alphahull: -1,
      hoverinfo: "skip",
    };
    Plotly.react(this.el, [mesh], sceneLayout(s, this.log, (v) => this._h(v)), CONFIG);
    if (this.state) this._update(this.state, true);
  }

  _update(state, force = false) {
    if (!this._changed(state, force)) return;
    this._accumulate(state);
    const { x, y, z } = this._meshData();
    Plotly.restyle(this.el, { x: [x], y: [y], z: [z], intensity: [z] }, [0]);
  }
}

// Keeps the two 3D cameras in step, as in the original viewer.
export function syncCameras(a, b) {
  let syncing = false;
  const link = (src, dst) =>
    src.on("plotly_relayout", (ev) => {
      if (syncing || !ev["scene.camera"]) return;
      syncing = true;
      Plotly.relayout(dst, { "scene.camera": ev["scene.camera"] }).then(() => (syncing = false));
    });
  link(a, b);
  link(b, a);
}

export class ConvergencePlot {
  constructor(el) {
    this.el = el;
    this.fOpt = 0;
    this.count = -1;
    this.refresh = throttle((s) => this._refresh(s), 60);
  }

  reset(fOpt) {
    this.fOpt = fOpt;
    this.count = -1;
    if (!window.Plotly) return;
    const trace = (name, color, dash) => ({
      type: "scatter", mode: "lines", name, x: [], y: [],
      line: { color, width: 2, dash },
    });
    Plotly.react(
      this.el,
      [trace("best", "#ebcb8b"), trace("mean", "#88c0d0", "dot")],
      {
        ...THEME,
        margin: { l: 50, r: 10, t: 6, b: 30 },
        xaxis: { title: { text: "epoch", standoff: 4 }, gridcolor: "#4c566a", zeroline: false },
        yaxis: { type: "log", gridcolor: "#4c566a", exponentformat: "power" },
        legend: { orientation: "h", x: 1, xanchor: "right", y: 1, bgcolor: "rgba(0,0,0,0)" },
        shapes: [],
      },
      CONFIG_2D,
    );
  }

  _refresh(state) {
    if (!window.Plotly || !this.el.data) return;
    const n = state.frames.length;
    if (n !== this.count) {
      this.count = n;
      const gap = (v) => Math.max(v - this.fOpt, 1e-12);
      const x = state.frames.map((f) => f.epoch);
      Plotly.restyle(
        this.el,
        { x: [x, x], y: [state.frames.map((f) => gap(f.best_score)), state.frames.map((f) => gap(f.mean_score))] },
        [0, 1],
      );
    }
    const t = state.t;
    Plotly.relayout(this.el, {
      shapes: [{
        type: "line", xref: "x", yref: "paper", x0: t, x1: t, y0: 0, y1: 1,
        line: { color: "#bf616a", width: 1.5 },
      }],
    });
  }
}
