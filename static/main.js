// static/main.js

// Suppress "willReadFrequently" warning
const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, options) {
  if (type === "2d") {
    options = options || {};
    options.willReadFrequently = true;
  }
  return originalGetContext.call(this, type, options);
};

document.addEventListener("DOMContentLoaded", () => {
  // UI Elements
  const els = {
    func: document.getElementById("funcSelect"),
    algo: document.getElementById("algoSelect"),
    init: document.getElementById("initSelect"),
    pop: document.getElementById("popInput"),
    epochs: document.getElementById("epochInput"),
    threshold: document.getElementById("thresholdInput"),
    sleep: document.getElementById("sleepInput"),
    delayLabel: document.getElementById("delayVal"),
    btn: document.getElementById("startBtn"),
    gen: document.getElementById("genDisplay"),
    fit: document.getElementById("fitDisplay"),
    plotMain: document.getElementById("plotMain"),
    plotExplored: document.getElementById("plotExplored"),
  };

  // State Variables
  let currentEventSource = null;
  let isRunning = false;
  let animationFrameId = null;
  let pendingFrame = null;

  // Global Color Limits (Calculated once per function)
  let globalZMin = 0;
  let globalZMax = 100;

  const worker = new Worker("/static/worker.js");
  let isSyncingMain = false;
  let isSyncingExplored = false;

  // --- Config & Init ---
  els.sleep.addEventListener(
    "input",
    (e) => (els.delayLabel.textContent = e.target.value),
  );

  fetch("/config")
    .then((res) => res.json())
    .then((data) => {
      populateSelect(els.func, data.functions);
      populateSelect(els.algo, data.algorithms);
      populateSelect(els.init, data.initializers);

      // Initialize plots, then trigger the first preview
      initPlots().then(() => updatePreview());
    });

  function populateSelect(element, items) {
    items.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item;
      opt.textContent = item;
      element.appendChild(opt);
    });
  }

  // --- Preview Logic ---
  async function updatePreview() {
    // Only preview if not currently running a full optimization
    if (isRunning) return;

    // Reset Worker History so the "Explored" mesh shows ONLY the init distribution
    worker.postMessage({ type: "RESET" });

    const payload = {
      function: els.func.value,
      initializer: els.init.value,
      pop_size: els.pop.value,
    };

    try {
      const response = await fetch("/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      // Reset UI stats
      els.gen.textContent = "0";
      els.fit.textContent = data.best_score.toFixed(5);

      // Send to worker to generate mesh/scatter data
      worker.postMessage({ type: "DATA", payload: data });

      // Trigger a single render
      requestAnimationFrame(renderLoop);
    } catch (e) {
      console.error("Preview failed", e);
    }
  }

  // Bind Preview Triggers
  els.func.addEventListener("change", () => {
    // Re-init plots (new function surface), then preview
    worker.postMessage({ type: "RESET" });
    initPlots().then(() => updatePreview());
  });
  els.init.addEventListener("change", updatePreview);
  els.pop.addEventListener("change", updatePreview);

  // --- Plotting Setup ---
  async function initPlots() {
    const funcName = els.func.value || "Sphere";

    const response = await fetch("/surface", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ function: funcName }),
    });
    const surfaceData = await response.json();

    // 1. Calculate and Store Global Z-Range
    const allZ = surfaceData.z.flat();
    globalZMin = Math.min(...allZ);
    globalZMax = Math.max(...allZ);

    const baseLayout = {
      paper_bgcolor: "#3B4252",
      font: { color: "#D8DEE9" },
      margin: { l: 0, r: 0, b: 0, t: 30 },
      scene: {
        xaxis: { title: "X", gridcolor: "#4C566A", range: [-5, 5] },
        yaxis: { title: "Y", gridcolor: "#4C566A", range: [-5, 5] },
        zaxis: {
          title: "Fit",
          gridcolor: "#4C566A",
          range: [globalZMin, globalZMax],
        },
        aspectmode: "manual",
        aspectratio: { x: 1, y: 1, z: 0.7 },
        camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } },
      },
    };

    // Plot 1: Main (True Surface)
    const layoutMain = JSON.parse(JSON.stringify(baseLayout));
    layoutMain.title = "True Landscape";
    const traceTrueSurface = {
      x: surfaceData.x,
      y: surfaceData.y,
      z: surfaceData.z,
      type: "surface",
      colorscale: "Viridis",
      cmin: globalZMin,
      cmax: globalZMax,
      showscale: false,
      opacity: 0.6,
      contours: { z: { show: true, usecolormap: true, project: { z: true } } },
    };
    const tracePopulation = {
      x: [],
      y: [],
      z: [],
      mode: "markers",
      type: "scatter3d",
      marker: { size: 4, color: "#BF616A", symbol: "circle" },
    };
    await Plotly.newPlot(
      els.plotMain,
      [traceTrueSurface, tracePopulation],
      layoutMain,
    );

    // Plot 2: Explored (Mesh)
    const layoutExplored = JSON.parse(JSON.stringify(baseLayout));
    layoutExplored.title = "Explored Area";
    const traceExplored = {
      x: [],
      y: [],
      z: [],
      type: "mesh3d",
      intensity: [],
      colorscale: "Viridis",
      cmin: globalZMin,
      cmax: globalZMax,
      showscale: true,
      colorbar: { len: 0.8 },
      opacity: 1.0,
      alphahull: -1,
    };
    await Plotly.newPlot(els.plotExplored, [traceExplored], layoutExplored);

    attachCameraSync();
  }

  // --- Worker Communication ---
  worker.onmessage = function (e) {
    pendingFrame = e.data;
    // If not running (preview mode), render immediately
    if (!isRunning) requestAnimationFrame(renderLoop);
  };

  // --- Main Render Loop ---
  function renderLoop() {
    if (pendingFrame) {
      // UI Stats (Only update if running, or if previewing generation 0)
      if (isRunning || pendingFrame.stats.epoch === 0) {
        els.gen.textContent = pendingFrame.stats.epoch;
        els.fit.textContent = pendingFrame.stats.best.toFixed(5);
      }

      // Update Plot 1 (Scatter)
      Plotly.restyle(
        els.plotMain,
        {
          x: [pendingFrame.scatter.x],
          y: [pendingFrame.scatter.y],
          z: [pendingFrame.scatter.z],
        },
        [1],
      );

      // Update Plot 2 (Mesh)
      const newMesh = {
        x: pendingFrame.mesh.x,
        y: pendingFrame.mesh.y,
        z: pendingFrame.mesh.z,
        intensity: pendingFrame.mesh.z,
        type: "mesh3d",
        colorscale: "Viridis",
        cmin: globalZMin,
        cmax: globalZMax,
        alphahull: -1,
        opacity: 1.0,
      };

      Plotly.react(els.plotExplored, [newMesh], els.plotExplored.layout);
      pendingFrame = null;
    }

    if (isRunning) {
      animationFrameId = requestAnimationFrame(renderLoop);
    }
  }

  // --- Stream Control ---
  els.btn.addEventListener("click", () => {
    if (currentEventSource) currentEventSource.close();
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    els.btn.disabled = true;
    els.gen.textContent = "0";
    els.fit.textContent = "--";

    // Reset worker history for the new run
    worker.postMessage({ type: "RESET" });

    isRunning = true;
    pendingFrame = null;

    const params = new URLSearchParams({
      algorithm: els.algo.value,
      function: els.func.value,
      initializer: els.init.value,
      pop_size: els.pop.value,
      epochs: els.epochs.value,
      threshold: els.threshold.value,
      sleep: els.sleep.value,
    });

    currentEventSource = new EventSource(`/stream?${params.toString()}`);
    requestAnimationFrame(renderLoop);

    currentEventSource.onmessage = (event) => {
      if (event.data === "Done") {
        stopStream();
        return;
      }
      const data = JSON.parse(event.data);
      if (data.error) {
        console.error(data.error);
        stopStream();
        return;
      }
      worker.postMessage({ type: "DATA", payload: data });
    };

    currentEventSource.addEventListener("done", () => {
      stopStream();
    });

    currentEventSource.onerror = () => {
      stopStream();
    };
  });

  function stopStream() {
    isRunning = false;
    if (currentEventSource) currentEventSource.close();
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    els.btn.disabled = false;
  }

  // --- Camera Sync ---
  function attachCameraSync() {
    els.plotMain.on("plotly_relayout", (eventData) => {
      if (isSyncingExplored) return;
      if (eventData["scene.camera"]) {
        isSyncingMain = true;
        Plotly.relayout(els.plotExplored, {
          "scene.camera": eventData["scene.camera"],
        }).then(() => (isSyncingMain = false));
      }
    });

    els.plotExplored.on("plotly_relayout", (eventData) => {
      if (isSyncingMain) return;
      if (eventData["scene.camera"]) {
        isSyncingExplored = true;
        Plotly.relayout(els.plotMain, {
          "scene.camera": eventData["scene.camera"],
        }).then(() => (isSyncingExplored = false));
      }
    });
  }
});
