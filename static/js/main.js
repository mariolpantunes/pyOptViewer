// App wiring: configuration form, run lifecycle, player and views.

import * as api from "./api.js";
import { Player } from "./player.js";
import { SpaceView } from "./space.js";
import { LandscapePlot, ExploredMeshPlot, ConvergencePlot, syncCameras } from "./plots.js";

const $ = (id) => document.getElementById(id);
const els = {
  function: $("function"), functionHint: $("functionHint"),
  sampler: $("sampler"), strategy: $("strategy"), popSize: $("popSize"), seed: $("seed"),
  algorithm: $("algorithm"), params: $("params"), epochs: $("epochs"), threshold: $("threshold"),
  runBtn: $("runBtn"), status: $("status"),
  playBtn: $("playBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"), firstBtn: $("firstBtn"), lastBtn: $("lastBtn"),
  scrub: $("scrub"), epochLabel: $("epochLabel"), speed: $("speed"),
  optSmooth: $("optSmooth"), optTrails: $("optTrails"), optVisited: $("optVisited"),
  optContours: $("optContours"), optLog: $("optLog"), optLive: $("optLive"),
  hover: $("hover"),
  statEpoch: $("statEpoch"), statBest: $("statBest"), statGap: $("statGap"),
  statMean: $("statMean"), statDiv: $("statDiv"), statPop: $("statPop"),
};

const fmt = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(3) : v.toFixed(4);
};

let catalogue = null;
let fOpt = 0;
let run = null; // { id, live, close, sendCursor, cursor }

const player = new Player();
const space = new SpaceView($("space"), (h) => {
  els.hover.textContent = h ? `x=${h.x.toFixed(2)}  y=${h.y.toFixed(2)}  f=${fmt(h.f)}` : "";
});
const landscape = new LandscapePlot($("plotMain"));
const explored = new ExploredMeshPlot($("plotExplored"));
const conv = new ConvergencePlot($("plotConv"));

// --- form ---------------------------------------------------------------------------

function fill(select, items, groups) {
  select.innerHTML = "";
  if (groups) {
    for (const [group, names] of Object.entries(groups)) {
      const og = document.createElement("optgroup");
      og.label = group;
      names.forEach((n) => og.append(new Option(n, n)));
      select.append(og);
    }
  } else items.forEach((n) => select.append(new Option(n, n)));
}

function renderParams() {
  const algo = catalogue.algorithms[els.algorithm.value];
  els.params.innerHTML = "";
  for (const p of algo.params) {
    const label = document.createElement("label");
    label.textContent = p.label;
    let input;
    if (p.kind === "choice") {
      input = document.createElement("select");
      p.choices.forEach((c) => input.append(new Option(c, c)));
      input.value = p.default;
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.step = p.step ?? "any";
      if (p.min !== null) input.min = p.min;
      if (p.max !== null) input.max = p.max;
      input.value = p.default ?? "";
      if (p.nullable) input.placeholder = "auto";
    }
    input.dataset.param = p.name;
    input.dataset.kind = p.kind;
    label.append(input);
    els.params.append(label);
  }
  if (!algo.params.length) els.params.innerHTML = '<p class="hint">No tunable parameters.</p>';
}

function readParams() {
  const out = {};
  els.params.querySelectorAll("[data-param]").forEach((el) => {
    if (el.dataset.kind === "choice") out[el.dataset.param] = el.value;
    else out[el.dataset.param] = el.value === "" ? null : Number(el.value);
  });
  return out;
}

const initBody = () => ({
  function: els.function.value,
  sampler: els.sampler.value,
  strategy: els.strategy.value,
  pop_size: Number(els.popSize.value),
  seed: Number(els.seed.value),
});

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

// --- data flow ------------------------------------------------------------------------

async function loadFunction() {
  const name = els.function.value;
  const info = catalogue.functions[name];
  els.functionHint.textContent = info.description;
  fOpt = info.f_opt;
  const [hi, lo] = await Promise.all([api.getSurface(name, 200), api.getSurface(name, 60)]);
  space.setSurface(hi);
  landscape.setSurface(lo);
  explored.setSurface(lo);
}

async function showPreview() {
  if (run) return;
  try {
    const frame = await api.preview(initBody());
    newTimeline([frame], false);
    setStatus("Initial population preview");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function newTimeline(frames, streaming) {
  player.load(frames, { streaming });
  space.resetVisited();
  explored.reset();
  conv.reset(fOpt);
}

async function startRun() {
  if (run) return cancel();
  const body = {
    ...initBody(),
    algorithm: els.algorithm.value,
    epochs: Number(els.epochs.value),
    threshold: Number(els.threshold.value) || 0,
    params: readParams(),
    live: els.optLive.checked,
  };
  let created;
  try {
    created = await api.createRun(body);
  } catch (e) {
    return setStatus(e.message, "error");
  }
  newTimeline([], true);
  player.play();
  setRunning(true);
  setStatus(body.live ? "Live: evolving as it plays…" : "Computing…");
  const stream = api.followRun(created.id, {
    onFrame: (f) => {
      player.push(f);
      if (body.live) setStatus(`Live: epoch ${f.epoch} of ${body.epochs} computed`);
    },
    onEnd: (msg) => {
      finish();
      const how = msg.status === "done" ? "Finished" : msg.status === "cancelled" ? "Cancelled" : "Error";
      setStatus(msg.error ? `${how}: ${msg.error}` : `${how} — ${msg.frames - 1} epochs, best ${fmt(msg.best_score)}`, msg.status === "error" ? "error" : "");
    },
    onError: (e) => {
      finish();
      setStatus(e.message, "error");
    },
  });
  run = { id: created.id, live: body.live, cursor: -1, ...stream };
  sendCursor(0);
}

async function cancel() {
  if (!run) return;
  try {
    await api.cancelRun(run.id);
  } catch {}
}

// Live runs: tell the server which epoch is on screen; the callback in the
// optimizer thread waits until the viewer is within its lookahead.
function sendCursor(index) {
  if (!run?.live || index === run.cursor) return;
  run.cursor = index;
  run.sendCursor(index);
}

function finish() {
  player.streaming = false;
  player.invalidate();
  run?.close();
  run = null;
  setRunning(false);
}

function setRunning(on) {
  els.runBtn.textContent = on ? "Cancel" : "Run";
  els.runBtn.classList.toggle("danger", on);
}

// --- rendering -------------------------------------------------------------------------

player.onUpdate((s) => {
  sendCursor(s.index);
  space.render(s);
  landscape.update(s);
  explored.update(s);
  conv.refresh(s);

  els.scrub.max = player.last;
  els.scrub.value = s.t;
  els.epochLabel.textContent = `${Math.round(s.t)} / ${player.last}`;
  els.playBtn.textContent = player.playing ? "⏸" : "▶";

  const f = s.u > 0.5 ? s.b : s.a;
  els.statEpoch.textContent = f.epoch;
  els.statBest.textContent = fmt(f.best_score);
  els.statGap.textContent = fmt(f.best_score - fOpt);
  els.statMean.textContent = fmt(f.mean_score);
  els.statPop.textContent = f.pop.length;
  els.statDiv.textContent = fmt(diversity(f.pop));
});

// Mean distance to the centroid: how spread out the population still is.
function diversity(pop) {
  const n = pop.length;
  const cx = pop.reduce((s, p) => s + p[0], 0) / n;
  const cy = pop.reduce((s, p) => s + p[1], 0) / n;
  return pop.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
}

// --- events ------------------------------------------------------------------------------

function bind() {
  els.function.addEventListener("change", async () => {
    await loadFunction();
    showPreview();
  });
  for (const el of [els.sampler, els.strategy, els.popSize, els.seed]) el.addEventListener("change", showPreview);
  els.algorithm.addEventListener("change", renderParams);
  els.runBtn.addEventListener("click", startRun);

  els.playBtn.addEventListener("click", () => player.toggle());
  els.prevBtn.addEventListener("click", () => player.step(-1));
  els.nextBtn.addEventListener("click", () => player.step(1));
  els.firstBtn.addEventListener("click", () => (player.pause(), player.seek(0)));
  els.lastBtn.addEventListener("click", () => (player.pause(), player.seek(player.last)));
  els.scrub.addEventListener("input", () => (player.pause(), player.seek(Number(els.scrub.value))));
  els.speed.addEventListener("change", () => (player.speed = Number(els.speed.value)));

  const viewOpts = () => {
    player.smooth = els.optSmooth.checked;
    space.setOptions({
      trails: els.optTrails.checked,
      visited: els.optVisited.checked,
      contours: els.optContours.checked,
      log: els.optLog.checked,
    });
    landscape.setLog(els.optLog.checked);
    explored.setLog(els.optLog.checked);
    player.invalidate();
  };
  for (const el of [els.optSmooth, els.optTrails, els.optVisited, els.optContours, els.optLog]) el.addEventListener("change", viewOpts);

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    const keys = {
      " ": () => player.toggle(),
      ArrowLeft: () => player.step(-1),
      ArrowRight: () => player.step(1),
      Home: () => (player.pause(), player.seek(0)),
      End: () => (player.pause(), player.seek(player.last)),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  });
}

async function boot() {
  catalogue = await api.getConfig();
  fill(els.function, Object.keys(catalogue.functions));
  fill(els.sampler, catalogue.samplers);
  fill(els.strategy, catalogue.strategies);
  const groups = {};
  for (const [name, a] of Object.entries(catalogue.algorithms)) (groups[a.family] ??= []).push(name);
  fill(els.algorithm, null, groups);
  els.function.value = "Rastrigin";
  els.algorithm.value = "Particle Swarm";
  renderParams();
  bind();
  await loadFunction();
  syncCameras($("plotMain"), $("plotExplored"));
  await showPreview();
}

boot().catch((e) => setStatus(`Failed to start: ${e.message}`, "error"));
