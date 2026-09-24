"""FastAPI application: REST for setup, WebSocket for live frames."""

import asyncio
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from . import __version__, registry
from .runs import RunConfig, RunManager

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
ASSETS = ROOT / "assets"

app = FastAPI(title="pyOptViewer", version=__version__)
runs = RunManager()


class InitRequest(BaseModel):
    function: str = "Sphere"
    sampler: str = "Random"
    strategy: str = "None"
    pop_size: int = Field(30, ge=2, le=500)
    seed: int = 42

    @model_validator(mode="after")
    def _known(self):
        for value, table in (
            (self.function, registry.FUNCTIONS),
            (self.sampler, registry.SAMPLERS),
            (self.strategy, registry.STRATEGIES),
        ):
            if value not in table:
                raise ValueError(f"unknown option '{value}'")
        return self


class RunRequest(InitRequest):
    algorithm: str = "Particle Swarm"
    epochs: int = Field(100, ge=1, le=5000)
    threshold: float = Field(0.0, ge=0.0)
    params: dict[str, Any] = {}
    # Live: the optimizer waits for the viewer's cursor (WebSocket or PUT .../cursor).
    live: bool = False

    @model_validator(mode="after")
    def _known_algorithm(self):
        if self.algorithm not in registry.ALGORITHMS:
            raise ValueError(f"unknown algorithm '{self.algorithm}'")
        return self


# --- REST ------------------------------------------------------------------------


@app.get("/api/config")
def config() -> dict:
    return registry.catalogue()


@app.get("/api/surface/{function}")
def surface(function: str, resolution: int = 120) -> dict:
    """Function values on a regular grid; row j is y[j], column i is x[i]."""
    fn = registry.FUNCTIONS.get(function)
    if fn is None:
        raise HTTPException(404, f"unknown function '{function}'")
    resolution = int(np.clip(resolution, 10, 400))
    lo, hi = registry.BOUNDS[0]
    axis = np.linspace(lo, hi, resolution)
    X, Y = np.meshgrid(axis, axis)
    Z = fn.func(np.stack((X.ravel(), Y.ravel()), axis=-1)).reshape(X.shape)
    return {
        "function": function,
        "x": np.round(axis, 6).tolist(),
        "y": np.round(axis, 6).tolist(),
        "z": np.round(Z, 6).tolist(),
        "z_min": float(Z.min()),
        "z_max": float(Z.max()),
        "optima": [list(o) for o in fn.optima],
        "f_opt": fn.f_opt,
    }


@app.post("/api/preview")
def preview(req: InitRequest) -> dict:
    """The initial population the chosen sampler/strategy produce, with fitness."""
    fn = registry.FUNCTIONS[req.function]
    try:
        pop, _ = registry.initial_population(
            fn.func, req.pop_size, req.sampler, req.strategy, req.seed
        )
    except Exception as e:
        raise HTTPException(422, f"{type(e).__name__}: {e}") from e
    scores = fn.func(pop)
    i = int(np.argmin(scores))
    return {
        "epoch": 0,
        "pop": np.round(pop, 5).tolist(),
        "scores": np.round(scores, 6).tolist(),
        "best_pos": np.round(pop[i], 5).tolist(),
        "best_score": float(scores[i]),
        "mean_score": float(np.mean(scores)),
    }


@app.post("/api/runs", status_code=201)
def create_run(req: RunRequest) -> dict:
    try:
        run = runs.create(RunConfig(**req.model_dump()))
    except (ValueError, TypeError) as e:
        raise HTTPException(422, str(e)) from e
    return {**run.summary(), "ws": f"/ws/runs/{run.id}"}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, since: int = 0) -> dict:
    """Run status plus the frames produced from index `since` on (REST polling)."""
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    return {**run.summary(), "since": since, "data": run.frames[since:]}


class Cursor(BaseModel):
    index: int = Field(ge=0)


@app.put("/api/runs/{run_id}/cursor")
def set_cursor(run_id: str, cursor: Cursor) -> dict:
    """Advances a live run: the optimizer may run LOOKAHEAD frames past `index`."""
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    run.set_cursor(cursor.index)
    return run.summary()


@app.delete("/api/runs/{run_id}", status_code=204)
def delete_run(run_id: str) -> None:
    if not runs.delete(run_id):
        raise HTTPException(404, "run not found")


# --- WebSocket ---------------------------------------------------------------------


@app.websocket("/ws/runs/{run_id}")
async def stream_run(ws: WebSocket, run_id: str, since: int = 0) -> None:
    """Sends `{"type": "frame"}` messages, then one `{"type": "end"}`.

    Accepts `{"type": "cursor", "index": i}` from the client, which paces live runs.
    """
    await ws.accept()
    run = runs.get(run_id)
    if run is None:
        await ws.send_json({"type": "end", "status": "error", "error": "run not found"})
        await ws.close()
        return

    async def receive_cursors() -> None:
        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "cursor":
                    run.set_cursor(int(msg.get("index", 0)))
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass  # socket closed or malformed message: stop listening

    receiver = asyncio.create_task(receive_cursors())
    try:
        async for frame in run.follow(since):
            await ws.send_json({"type": "frame", "frame": frame})
        await ws.send_json({"type": "end", **run.summary()})
        await ws.close()
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()


# --- Static frontend ---------------------------------------------------------------------


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")
