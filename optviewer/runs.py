"""Optimisation runs: executed in a worker thread, observed through subscriptions.

A pyBlindOpt callback (`LiveCallback`) publishes one frame per epoch. In live
mode it also blocks the optimizer until the viewer's playback cursor is within
`LOOKAHEAD` frames, so the population evolves at the pace it is watched:
pausing the player pauses the optimizer. Batch mode runs at full speed.
"""

import asyncio
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import numpy as np
from pyBlindOpt.optimizer import Optimizer

from . import registry


@dataclass
class RunConfig:
    function: str
    algorithm: str
    sampler: str = "Random"
    strategy: str = "None"
    pop_size: int = 30
    epochs: int = 100
    seed: int = 42
    threshold: float = 0.0
    params: dict[str, Any] | None = None
    live: bool = False


# Frames the optimizer may run ahead of the viewer: enough for the player to
# always have the next epoch ready to interpolate towards.
LOOKAHEAD = 2
# A live run nobody advances for this long is cancelled, freeing its thread.
IDLE_TIMEOUT = 300.0


def _round(a: np.ndarray, digits: int = 5) -> list:
    return np.round(a, digits).tolist()


def make_frame(epoch: int, pop: np.ndarray, scores: np.ndarray, best_pos, best_score) -> dict:
    return {
        "epoch": epoch,
        "pop": _round(pop),
        "scores": _round(scores, 6),
        "best_pos": _round(np.asarray(best_pos)) if best_pos is not None else None,
        "best_score": float(best_score),
        "mean_score": float(np.mean(scores)),
    }


class LiveCallback:
    """pyBlindOpt callback: publish the epoch, stop on the threshold, pace live runs.

    Called by `Optimizer.optimize` after every generation as
    `callback(epoch, scores, population)`; returning True stops the run.
    """

    def __init__(self, run: "Run", f_opt: float, threshold: float):
        self.run = run
        self.f_opt = f_opt
        self.threshold = threshold

    def __call__(self, epoch: int, scores: np.ndarray, population: np.ndarray) -> bool:
        opt = self.run._optimizer
        frame = make_frame(epoch + 1, population, scores, opt.best_pos, opt.best_score)
        self.run._append(frame)
        if self.threshold > 0 and opt.best_score - self.f_opt <= self.threshold:
            return True
        return not self.run._wait_for_viewer(frame["epoch"])


class Run:
    def __init__(self, config: RunConfig):
        self.id = uuid.uuid4().hex[:12]
        self.config = config
        self.frames: list[dict] = []
        self.status = "pending"  # pending | running | done | cancelled | error
        self.error: str | None = None
        self.created = time.time()
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
        self._thread: threading.Thread | None = None
        self._cursor = 0  # frame the viewer is showing (live mode)
        self._gate = threading.Condition()
        # Built eagerly so configuration errors surface in the POST response.
        self._optimizer: Optimizer = self._build()

    # -- setup ---------------------------------------------------------------

    def _build(self) -> Optimizer:
        c = self.config
        fn = registry.FUNCTIONS[c.function]
        algo = registry.ALGORITHMS[c.algorithm]
        kwargs = algo.build_kwargs(c.params or {})
        pop, rng = registry.initial_population(fn.func, c.pop_size, c.sampler, c.strategy, c.seed)
        callback = LiveCallback(self, fn.f_opt, c.threshold)
        return algo.cls(
            fn.func,
            registry.BOUNDS,
            population=pop,
            n_pop=c.pop_size,
            n_iter=c.epochs,
            seed=rng,
            callback=callback,
            **kwargs,
        )

    # -- execution -------------------------------------------------------------

    def start(self) -> None:
        self.status = "running"
        self._thread = threading.Thread(target=self._execute, daemon=True, name=f"run-{self.id}")
        self._thread.start()

    def _execute(self) -> None:
        opt = self._optimizer
        # Frame 0 is the population as initialised, before any evolution.
        i = int(np.argmin(opt.scores))
        self._append(make_frame(0, opt.pop, opt.scores, opt.pop[i], opt.scores[i]))
        try:
            opt.optimize()
            self.status = "cancelled" if self._cancel.is_set() else "done"
        except Exception as e:  # noqa: BLE001 -- reported to the client, not lost in a dead thread
            self.error = f"{type(e).__name__}: {e}"
            self.status = "error"
        finally:
            self._notify()

    def cancel(self) -> None:
        self._cancel.set()
        with self._gate:
            self._gate.notify_all()

    def set_cursor(self, index: int) -> None:
        """Viewer reports the frame it shows; live runs may run LOOKAHEAD ahead."""
        with self._gate:
            self._cursor = max(0, int(index))
            self._gate.notify_all()

    def _wait_for_viewer(self, produced: int) -> bool:
        """Blocks the optimizer thread while it is too far ahead; False = cancelled."""
        if not self.config.live:
            return not self._cancel.is_set()
        with self._gate:
            while produced >= self._cursor + LOOKAHEAD and not self._cancel.is_set():
                if not self._gate.wait(timeout=IDLE_TIMEOUT):
                    self._cancel.set()  # abandoned: nobody advanced the cursor
        return not self._cancel.is_set()

    @property
    def finished(self) -> bool:
        return self.status in ("done", "cancelled", "error")

    # -- observation -------------------------------------------------------------

    def _append(self, frame: dict) -> None:
        with self._lock:
            self.frames.append(frame)
        self._notify()

    def _notify(self) -> None:
        for loop, event in list(self._subscribers):
            loop.call_soon_threadsafe(event.set)

    async def follow(self, start: int = 0):
        """Yields frames from `start`: buffered ones first, then live ones."""
        event = asyncio.Event()
        sub = (asyncio.get_running_loop(), event)
        self._subscribers.add(sub)
        try:
            idx = start
            while True:
                event.clear()
                with self._lock:
                    pending = self.frames[idx:]
                for frame in pending:
                    yield frame
                idx += len(pending)
                if self.finished and idx >= len(self.frames):
                    return
                await event.wait()
        finally:
            self._subscribers.discard(sub)

    def summary(self) -> dict:
        last = self.frames[-1] if self.frames else None
        return {
            "id": self.id,
            "status": self.status,
            "error": self.error,
            "frames": len(self.frames),
            "best_score": last["best_score"] if last else None,
            "best_pos": last["best_pos"] if last else None,
            "cursor": self._cursor,
            "config": self.config.__dict__,
        }


class RunManager:
    """Keeps the most recent runs in memory; older ones are cancelled and evicted."""

    def __init__(self, capacity: int = 32):
        self.capacity = capacity
        self._runs: OrderedDict[str, Run] = OrderedDict()

    def create(self, config: RunConfig) -> Run:
        run = Run(config)
        self._runs[run.id] = run
        while len(self._runs) > self.capacity:
            _, old = self._runs.popitem(last=False)
            old.cancel()
        run.start()
        return run

    def get(self, run_id: str) -> Run | None:
        return self._runs.get(run_id)

    def delete(self, run_id: str) -> bool:
        run = self._runs.pop(run_id, None)
        if run is None:
            return False
        run.cancel()
        return True
