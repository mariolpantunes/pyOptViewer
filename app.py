# app.py
import json
import os
import queue
import threading
import time

import numpy as np
from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from pyBlindOpt import functions, init, utils
from pyBlindOpt.de import DifferentialEvolution
from pyBlindOpt.gwo import GWO
from pyBlindOpt.hc import HillClimbing
from pyBlindOpt.pso import ParticleSwarmOptimization
from pyBlindOpt.rs import RandomSearch
from pyBlindOpt.sa import SimulatedAnnealing

app = Flask(__name__)

# --- Configuration Maps ---
ALGORITHMS = {
    "PSO": ParticleSwarmOptimization,
    "DE": DifferentialEvolution,
    "GWO": GWO,
    "HillClimbing": HillClimbing,
    "SimulatedAnnealing": SimulatedAnnealing,
    "RandomSearch": RandomSearch,
}

FUNCTIONS = {
    "Sphere": functions.sphere,
    "Rastrigin": functions.rastrigin,
    "Ackley": functions.ackley,
    "Rosenbrock": functions.rosenbrock,
    "Griewank": functions.griewank,
}

# Combine Samplers and Advanced Init Strategies for the UI
# We flag them to know how to instantiate them later
INITIALIZERS = {
    # Basic Samplers (pass as 'seed')
    "Random": {"type": "sampler", "class": utils.RandomSampler},
    "Sobol": {"type": "sampler", "class": utils.SobolSampler},
    "Chaotic": {"type": "sampler", "class": utils.ChaoticSampler},
    # Advanced Strategies (generate 'population' array)
    "OBL": {"type": "advanced", "func": init.opposition_based},
    "Quasi-OBL": {"type": "advanced", "func": init.quasi_opposition_based},
    "OBLESA": {"type": "advanced", "func": init.oblesa},
}


def get_surface_data(func_name, bounds):
    """Generates the 3D mesh for the function landscape."""
    func = FUNCTIONS[func_name]
    x = np.linspace(bounds[0], bounds[1], 50)
    y = np.linspace(bounds[0], bounds[1], 50)
    X, Y = np.meshgrid(x, y)

    # Flatten for evaluation
    input_mesh = np.stack((X.ravel(), Y.ravel()), axis=-1)
    Z = func(input_mesh).reshape(X.shape)

    return {"x": X.tolist(), "y": Y.tolist(), "z": Z.tolist(), "type": "surface"}


class StreamingCallback:
    """Callback to push optimization state to a queue."""

    def __init__(self, q, sleep_duration=0.1, stop_threshold=1e-3):
        self.q = q
        self.sleep_duration = sleep_duration
        self.stop_threshold = stop_threshold

    def __call__(self, epoch, scores, population):
        best_current = float(np.min(scores))

        data = {
            "epoch": int(epoch),
            "pop_x": population[:, 0].tolist(),
            "pop_y": population[:, 1].tolist(),
            "pop_z": scores.tolist(),
            "best_score": best_current,
        }
        self.q.put(data)

        # Physics simulation speed control
        if self.sleep_duration > 0:
            time.sleep(self.sleep_duration)

        # Early Stopping Condition (Minimization)
        if best_current <= self.stop_threshold:
            return True  # Signal to stop
        return False


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/assets/<path:filename>")
def serve_assets(filename):
    # Serves files from the 'assets' folder in the project root
    return send_from_directory(os.path.join(app.root_path, "assets"), filename)


@app.route("/config", methods=["GET"])
def get_config():
    return jsonify(
        {
            "algorithms": list(ALGORITHMS.keys()),
            "functions": list(FUNCTIONS.keys()),
            "initializers": list(INITIALIZERS.keys()),
        }
    )


@app.route("/surface", methods=["POST"])
def surface():
    """Returns static surface data for the plot."""
    data = request.json
    func_name = data.get("function", "Sphere")
    bounds = [-5, 5]
    return jsonify(get_surface_data(func_name, bounds))


@app.route("/preview", methods=["POST"])
def preview():
    """Generates an initial population for visualization."""
    data = request.json
    func_name = data.get("function", "Sphere")
    init_name = data.get("initializer", "Random")
    try:
        n_pop = int(data.get("pop_size", 30))
    except (ValueError, TypeError):
        n_pop = 30

    bounds = np.array([[-5.0, 5.0], [-5.0, 5.0]])
    objective = FUNCTIONS[func_name]
    rng = np.random.default_rng(42)

    init_config = INITIALIZERS.get(init_name, INITIALIZERS["Random"])

    # Generate Population
    if init_config["type"] == "sampler":
        sampler = init_config["class"](rng)
        pop = sampler.sample(n_pop, bounds)
    else:
        # Advanced methods (OBL, OBLESA) return the population array directly
        # We pass a RandomSampler as the base generator for them
        base_sampler = utils.RandomSampler(rng)
        pop = init_config["func"](
            objective=objective,
            bounds=bounds,
            population=base_sampler,  # Base sampler
            n_pop=n_pop,
        )

    # Evaluate Fitness for Visualization
    scores = utils.compute_objective(pop, objective)

    return jsonify(
        {
            "epoch": 0,
            "pop_x": pop[:, 0].tolist(),
            "pop_y": pop[:, 1].tolist(),
            "pop_z": scores.tolist(),
            "best_score": float(np.min(scores)),
        }
    )


@app.route("/stream")
def stream():
    """Streams optimization progress via SSE."""
    # Parse Query Parameters
    algo_name = request.args.get("algorithm", "PSO")
    func_name = request.args.get("function", "Sphere")
    init_name = request.args.get("initializer", "Random")

    try:
        epochs = int(request.args.get("epochs", 50))
        n_pop = int(request.args.get("pop_size", 30))
        sleep_time = float(request.args.get("sleep", 0.1))
        threshold = float(request.args.get("threshold", 1e-3))
    except ValueError:
        epochs = 50
        n_pop = 30
        sleep_time = 0.1
        threshold = 1e-3

    # Setup Logic
    bounds = np.array([[-5.0, 5.0], [-5.0, 5.0]])
    objective = FUNCTIONS[func_name]
    AlgoClass = ALGORITHMS[algo_name]
    rng = np.random.default_rng(42)

    init_config = INITIALIZERS.get(init_name, INITIALIZERS["Random"])

    # Init Optimizer Arguments
    opt_kwargs = {
        "objective": objective,
        "bounds": bounds,
        "n_pop": n_pop,
        "n_iter": epochs,
    }

    # Handle Initialization Strategy
    if init_config["type"] == "sampler":
        # Pass sampler as 'seed'
        opt_kwargs["seed"] = init_config["class"](rng)
    else:
        # Advanced: Generate population first, pass as 'population'
        # Note: We create a fresh base sampler for this request
        base_sampler = utils.RandomSampler(rng)
        population = init_config["func"](
            objective=objective, bounds=bounds, population=base_sampler, n_pop=n_pop
        )
        opt_kwargs["population"] = population

    # Communication Queue
    q = queue.Queue()
    callback = StreamingCallback(q, sleep_duration=sleep_time, stop_threshold=threshold)
    opt_kwargs["callback"] = callback

    # Init Optimizer
    try:
        opt = AlgoClass(**opt_kwargs)
    except Exception as e:
        return Response(
            f"data: {json.dumps({'error': str(e)})}\n\n", mimetype="text/event-stream"
        )

    def run_optimization():
        try:
            opt.optimize()
        finally:
            q.put("DONE")

    # Start Optimization in Thread
    thread = threading.Thread(target=run_optimization)
    thread.start()

    def generate():
        while True:
            item = q.get()
            if item == "DONE":
                yield "event: done\ndata: Done\n\n"
                break

            yield f"data: {json.dumps(item)}\n\n"

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
