// static/worker.js

// State: Global History Buffers
let historyX = [];
let historyY = [];
let historyZ = [];

self.onmessage = function (e) {
  const type = e.data.type;

  if (type === "RESET") {
    historyX = [];
    historyY = [];
    historyZ = [];
  } else if (type === "DATA") {
    const payload = e.data.payload;

    // 1. Accumulate Data (Calculation)
    // We push spread arrays (fast enough for batch sizes < 1000)
    historyX.push(...payload.pop_x);
    historyY.push(...payload.pop_y);
    historyZ.push(...payload.pop_z);

    // 2. Prepare Data Structures for Main Thread
    // We clone the data needed for rendering so the main thread
    // doesn't have to perform any logic, just assignment.
    const renderData = {
      // Data for Plot 1 (Current Population)
      scatter: {
        x: payload.pop_x,
        y: payload.pop_y,
        z: payload.pop_z,
      },
      // Data for Plot 2 (Explored Mesh)
      mesh: {
        x: historyX, // Structured clone will handle transfer
        y: historyY,
        z: historyZ,
      },
      stats: {
        epoch: payload.epoch,
        best: payload.best_score,
      },
    };

    // 3. Post back to Main
    self.postMessage(renderData);
  }
};
