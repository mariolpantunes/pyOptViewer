// REST + WebSocket client for the optviewer server.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

export const getConfig = () => request("GET", "/api/config");
export const getSurface = (fn, resolution) =>
  request("GET", `/api/surface/${encodeURIComponent(fn)}?resolution=${resolution}`);
export const preview = (body) => request("POST", "/api/preview", body);
export const createRun = (body) => request("POST", "/api/runs", body);
export const cancelRun = (id) => request("DELETE", `/api/runs/${id}`);

// Streams a run's frames. Returns { close, sendCursor }: the cursor (frame
// index being shown) paces live runs, the optimizer stays a few frames ahead.
export function followRun(id, { onFrame, onEnd, onError }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/runs/${id}`);
  let ended = false;
  let pendingCursor = null;
  const sendCursor = (index) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cursor", index }));
    else pendingCursor = index;
  };
  ws.onopen = () => pendingCursor !== null && sendCursor(pendingCursor);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "frame") onFrame(msg.frame);
    else if (msg.type === "end") {
      ended = true;
      onEnd(msg);
    }
  };
  ws.onerror = () => !ended && onError(new Error("WebSocket error"));
  ws.onclose = () => !ended && onError(new Error("connection closed"));
  return {
    sendCursor,
    close: () => {
      ended = true;
      ws.close();
    },
  };
}
