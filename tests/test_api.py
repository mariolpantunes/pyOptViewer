import time
import unittest

from fastapi.testclient import TestClient

from optviewer import registry
from optviewer.runs import LOOKAHEAD
from optviewer.server import app


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_config_lists_every_option(self):
        cfg = self.client.get("/api/config").json()
        self.assertEqual(set(cfg["algorithms"]), set(registry.ALGORITHMS))
        self.assertEqual(set(cfg["functions"]), set(registry.FUNCTIONS))
        de = {p["name"]: p for p in cfg["algorithms"]["Differential Evolution"]["params"]}
        self.assertEqual(de["F"]["default"], 0.5)
        self.assertIn("lshade", de["policy"]["choices"])

    def test_optima_are_minima(self):
        for name in registry.FUNCTIONS:
            s = self.client.get(f"/api/surface/{name}?resolution=101").json()
            self.assertLessEqual(s["f_opt"], s["z_min"] + 1e-6, name)

    def test_surface_unknown_function(self):
        self.assertEqual(self.client.get("/api/surface/Nope").status_code, 404)

    def test_preview_every_initialiser(self):
        for sampler in registry.SAMPLERS:
            for strategy in registry.STRATEGIES:
                body = {
                    "function": "Ackley",
                    "sampler": sampler,
                    "strategy": strategy,
                    "pop_size": 16,
                }
                r = self.client.post("/api/preview", json=body)
                self.assertEqual(r.status_code, 200, (sampler, strategy, r.text))
                self.assertEqual(len(r.json()["pop"]), 16)

    def test_rejects_bad_input(self):
        self.assertEqual(self.client.post("/api/preview", json={"sampler": "X"}).status_code, 422)
        bad = {"algorithm": "Particle Swarm", "params": {"w": 99}}
        self.assertEqual(self.client.post("/api/runs", json=bad).status_code, 422)
        bad = {"algorithm": "Differential Evolution", "params": {"policy": "nope"}}
        self.assertEqual(self.client.post("/api/runs", json=bad).status_code, 422)

    def test_run_streams_all_frames_over_websocket(self):
        body = {"function": "Sphere", "algorithm": "Particle Swarm", "epochs": 20, "pop_size": 10}
        run = self.client.post("/api/runs", json=body).json()
        frames = []
        with self.client.websocket_connect(run["ws"]) as ws:
            while (msg := ws.receive_json())["type"] == "frame":
                frames.append(msg["frame"])
        self.assertEqual(msg["status"], "done")
        self.assertEqual([f["epoch"] for f in frames], list(range(21)))
        best = [f["best_score"] for f in frames[1:]]
        self.assertEqual(best, sorted(best, reverse=True))  # best-so-far never worsens
        rest = self.client.get(f"/api/runs/{run['id']}?since=15").json()
        self.assertEqual(len(rest["data"]), 6)

    def test_threshold_stops_early(self):
        body = {
            "function": "Sphere",
            "algorithm": "Differential Evolution",
            "epochs": 2000,
            "threshold": 1e-3,
        }
        run = self.client.post("/api/runs", json=body).json()
        with self.client.websocket_connect(run["ws"]) as ws:
            while (msg := ws.receive_json())["type"] == "frame":
                pass
        self.assertLess(msg["frames"], 2001)
        self.assertLessEqual(msg["best_score"], 1e-3)

    def test_every_algorithm_runs(self):
        for name in registry.ALGORITHMS:
            body = {"function": "Rastrigin", "algorithm": name, "epochs": 5, "pop_size": 12}
            run = self.client.post("/api/runs", json=body).json()
            with self.client.websocket_connect(run["ws"]) as ws:
                while (msg := ws.receive_json())["type"] == "frame":
                    pass
            self.assertEqual(msg["status"], "done", (name, msg["error"]))

    def _frames_when_stable(self, run_id, expect):
        deadline = time.time() + 5
        n = 0
        while time.time() < deadline:
            n = self.client.get(f"/api/runs/{run_id}").json()["frames"]
            if n >= expect:
                time.sleep(0.2)  # give an unpaced optimizer the chance to overshoot
                return self.client.get(f"/api/runs/{run_id}").json()["frames"]
            time.sleep(0.02)
        return n

    def test_live_run_is_paced_by_the_cursor(self):
        body = {"function": "Sphere", "algorithm": "Particle Swarm", "epochs": 50, "live": True}
        rid = self.client.post("/api/runs", json=body).json()["id"]
        # Cursor 0: frames 0..LOOKAHEAD exist, then the callback blocks the optimizer.
        self.assertEqual(self._frames_when_stable(rid, LOOKAHEAD + 1), LOOKAHEAD + 1)
        self.client.put(f"/api/runs/{rid}/cursor", json={"index": 10})
        self.assertEqual(self._frames_when_stable(rid, 10 + LOOKAHEAD + 1), 10 + LOOKAHEAD + 1)
        self.assertEqual(self.client.get(f"/api/runs/{rid}").json()["status"], "running")
        self.client.delete(f"/api/runs/{rid}")

    def test_live_run_over_websocket(self):
        body = {"function": "Sphere", "algorithm": "Grey Wolf", "epochs": 30, "live": True}
        run = self.client.post("/api/runs", json=body).json()
        frames = []
        with self.client.websocket_connect(run["ws"]) as ws:
            while (msg := ws.receive_json())["type"] == "frame":
                frames.append(msg["frame"])
                ws.send_json({"type": "cursor", "index": msg["frame"]["epoch"]})
        self.assertEqual(msg["status"], "done")
        self.assertEqual(len(frames), 31)

    def test_delete(self):
        body = {"function": "Sphere", "algorithm": "Random Search", "epochs": 5}
        run = self.client.post("/api/runs", json=body).json()
        self.assertEqual(self.client.delete(f"/api/runs/{run['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/runs/{run['id']}").status_code, 404)


if __name__ == "__main__":
    unittest.main()
