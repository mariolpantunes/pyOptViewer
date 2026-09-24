"""Catalogue of everything the UI can select: functions, initialisation, algorithms.

Each entry is declarative so the REST layer can publish it as-is. Algorithm
parameter defaults are read from the constructor signatures, so they follow
pyBlindOpt instead of being copied here.
"""

import inspect
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pyBlindOpt as pbo
from pyBlindOpt import functions, ga, init, utils

BOUNDS = np.array([[-5.0, 5.0], [-5.0, 5.0]])


# --- Objective functions -------------------------------------------------------


@dataclass(frozen=True)
class Function:
    func: Callable[[np.ndarray], np.ndarray]
    optima: tuple[tuple[float, float], ...]
    description: str

    @property
    def f_opt(self) -> float:
        return float(self.func(np.array(self.optima[0])))


FUNCTIONS: dict[str, Function] = {
    "Sphere": Function(functions.sphere, ((0, 0),), "Unimodal, convex, separable."),
    "Rastrigin": Function(
        functions.rastrigin, ((0, 0),), "Highly multimodal, regular grid of local minima."
    ),
    "Ackley": Function(
        functions.ackley, ((0, 0),), "Nearly flat outer region, deep central funnel."
    ),
    "Rosenbrock": Function(
        functions.rosenbrock, ((1, 1),), "Narrow curved valley, easy to find, hard to follow."
    ),
    "Griewank": Function(functions.griewank, ((0, 0),), "Many shallow local minima on a bowl."),
    "Styblinski-Tang": Function(
        functions.styblinski_tang,
        ((-2.903534, -2.903534),),
        "Multimodal, optimum near a corner.",
    ),
    "Levy": Function(functions.levy, ((1, 1),), "Multimodal with ridged structure."),
    "Zakharov": Function(functions.zakharov, ((0, 0),), "Unimodal plate with steep walls."),
    "Dixon-Price": Function(
        functions.dixon_price,
        ((1.0, 2**-0.5), (1.0, -(2**-0.5))),
        "Valley with two symmetric global minima.",
    ),
    "Schwefel": Function(
        functions.schwefel,
        ((4.209687, 4.209687),),
        "Deceptive: second-best minima lie far from the global one.",
    ),
    "Lunacek": Function(
        functions.lunacek_bi_rastrigin,
        ((1.25, 1.25),),
        "Double-funnel Rastrigin, the larger funnel is the wrong one.",
    ),
}


# --- Initialisation --------------------------------------------------------------

SAMPLERS: dict[str, type[utils.Sampler]] = {
    "Random": utils.RandomSampler,
    "Latin Hypercube": utils.HLCSampler,
    "Sobol": utils.SobolSampler,
    "Chaotic": utils.ChaoticSampler,
}


def _obl(objective, n_pop, sampler, rng):
    return init.opposition_based(objective, BOUNDS, population=sampler, n_pop=n_pop, seed=rng)


def _qobl(objective, n_pop, sampler, rng):
    return init.quasi_opposition_based(objective, BOUNDS, population=sampler, n_pop=n_pop, seed=rng)


def _oblesa(objective, n_pop, sampler, rng):
    return init.oblesa(objective, BOUNDS, population=sampler, n_pop=n_pop, seed=rng)


def _round(objective, n_pop, sampler, rng):
    return init.round_init(objective, BOUNDS, sampler, n_pop=n_pop)


# Strategy(objective, n_pop, sampler, rng) -> population, or None for plain sampling.
STRATEGIES: dict[str, Callable[..., np.ndarray] | None] = {
    "None": None,
    "OBL": _obl,
    "Quasi-OBL": _qobl,
    "OBLESA": _oblesa,
    "Round": _round,
}


def initial_population(
    objective: Callable, n_pop: int, sampler_name: str, strategy_name: str, seed: int
) -> tuple[np.ndarray, np.random.Generator]:
    """Builds the starting population; returns it with the RNG to hand on."""
    rng = np.random.default_rng(seed)
    sampler = SAMPLERS[sampler_name](rng)
    strategy = STRATEGIES[strategy_name]
    if strategy is None:
        pop = init.get_initial_population(n_pop, BOUNDS, sampler)
    else:
        pop = strategy(objective, n_pop, sampler, rng)
    return np.asarray(pop, dtype=float), rng


# --- Algorithms ------------------------------------------------------------------


@dataclass(frozen=True)
class Param:
    name: str
    kind: str  # "float" | "int" | "choice"
    label: str = ""
    min: float | None = None
    max: float | None = None
    step: float | None = None
    choices: tuple[str, ...] = ()
    nullable: bool = False


@dataclass(frozen=True)
class Algorithm:
    cls: type
    family: str
    params: tuple[Param, ...] = ()
    # Maps UI choice values to constructor values (e.g. names to functions).
    converters: dict[str, dict[str, Any]] = field(default_factory=dict)
    defaults_override: dict[str, Any] = field(default_factory=dict)

    def defaults(self) -> dict[str, Any]:
        sig = inspect.signature(self.cls.__init__).parameters
        out = {}
        for p in self.params:
            if p.name in self.defaults_override:
                out[p.name] = self.defaults_override[p.name]
            else:
                out[p.name] = sig[p.name].default
        return out

    def build_kwargs(self, values: dict[str, Any]) -> dict[str, Any]:
        """Validates UI values against the schema; returns constructor kwargs."""
        merged = self.defaults() | {
            k: v for k, v in values.items() if k in {p.name for p in self.params}
        }
        kwargs = {}
        for p in self.params:
            v = merged[p.name]
            if v is None:
                if not p.nullable:
                    raise ValueError(f"{p.name}: a value is required")
                kwargs[p.name] = None
                continue
            if p.kind == "choice":
                if v not in p.choices:
                    raise ValueError(f"{p.name}: '{v}' not in {list(p.choices)}")
                v = self.converters.get(p.name, {}).get(v, v)
            else:
                v = int(v) if p.kind == "int" else float(v)
                if p.min is not None and v < p.min or p.max is not None and v > p.max:
                    raise ValueError(f"{p.name}: {v} outside [{p.min}, {p.max}]")
            kwargs[p.name] = v
        return kwargs


_DE_VARIANTS = tuple(
    f"{m}/{c}"
    for m in (
        "rand/1",
        "best/1",
        "rand/2",
        "best/2",
        "current-to-best/1",
        "current-to-pbest/1",
        "current-to-rand/1",
    )
    for c in ("bin", "exp")
)
_DE_POLICIES = ("fixed", "archive", "jade", "shade", "lshade", "code", "sade", "ensemble")

_GA_CROSSOVER = {"blend": ga.blend_crossover, "linear": ga.linear_crossover}
_GA_MUTATION = {
    "polynomial": ga.polynomial_mutation,
    "gaussian": ga.gaussian_mutation,
    "random": ga.random_mutation,
}

ALGORITHMS: dict[str, Algorithm] = {
    "Random Search": Algorithm(pbo.RandomSearch, "Baseline"),
    "Hill Climbing": Algorithm(
        pbo.HillClimbing,
        "Local search",
        (Param("step_size", "float", "Step size", 1e-4, 5, 0.01),),
    ),
    "Simulated Annealing": Algorithm(
        pbo.SimulatedAnnealing,
        "Local search",
        (
            Param("step_size", "float", "Step size", 1e-4, 5, 0.01),
            Param("temp", "float", "Initial temperature", 1e-3, 1000, 1),
        ),
    ),
    "Genetic Algorithm": Algorithm(
        pbo.GeneticAlgorithm,
        "Evolutionary",
        (
            Param("crossover", "choice", "Crossover", choices=tuple(_GA_CROSSOVER)),
            Param("mutation", "choice", "Mutation", choices=tuple(_GA_MUTATION)),
            Param("r_cross", "float", "Crossover rate", 0, 1, 0.05),
            Param("r_mut", "float", "Mutation rate (empty = 1/D)", 0, 1, 0.05, nullable=True),
            Param("elitism", "float", "Elitism", 0, 1, 0.05),
        ),
        converters={"crossover": _GA_CROSSOVER, "mutation": _GA_MUTATION},
        defaults_override={"crossover": "blend", "mutation": "polynomial"},
    ),
    "Differential Evolution": Algorithm(
        pbo.DifferentialEvolution,
        "Evolutionary",
        (
            Param("variant", "choice", "Variant", choices=_DE_VARIANTS),
            Param("policy", "choice", "Control policy", choices=_DE_POLICIES),
            Param("parent_selection", "choice", "Parent selection", choices=("rand", "tournament")),
            Param("F", "float", "F (differential weight)", 0, 2, 0.05),
            Param("cr", "float", "CR (crossover rate)", 0, 1, 0.05),
            Param("p", "float", "p (pbest fraction)", 0.01, 1, 0.01),
        ),
    ),
    "Particle Swarm": Algorithm(
        pbo.ParticleSwarmOptimization,
        "Swarm",
        (
            Param("w", "float", "Inertia w", 0, 1.5, 0.05),
            Param("c1", "float", "Cognitive c1", 0, 4, 0.1),
            Param("c2", "float", "Social c2", 0, 4, 0.1),
        ),
    ),
    "Grey Wolf": Algorithm(pbo.GWO, "Swarm"),
    "Enhanced Grey Wolf": Algorithm(
        pbo.EGWO,
        "Swarm",
        (Param("noise_scale", "float", "Noise scale", 0, 2, 0.05),),
    ),
    "Artificial Bee Colony": Algorithm(
        pbo.ArtificialBeeColony,
        "Swarm",
        (Param("limit", "int", "Abandonment limit", 1, 1000, 1),),
    ),
    "Firefly": Algorithm(
        pbo.FireflyAlgorithm,
        "Swarm",
        (
            Param("alpha", "float", "Randomness alpha", 0, 2, 0.05),
            Param("beta0", "float", "Attraction beta0", 0, 5, 0.1),
            Param("gamma", "float", "Absorption gamma", 0, 10, 0.1),
            Param("alpha_decay", "float", "Alpha decay", 0.5, 1, 0.01),
        ),
    ),
    "Harris Hawks": Algorithm(pbo.HarrisHawksOptimization, "Swarm"),
    "Cuckoo Search": Algorithm(
        pbo.CuckooSearch,
        "Swarm",
        (
            Param("pa", "float", "Discovery rate pa", 0, 1, 0.05),
            Param("alpha", "float", "Step scale alpha", 1e-4, 1, 0.01),
            Param("beta", "float", "Lévy exponent beta", 1.0, 2.0, 0.05),
        ),
    ),
    "Honey Badger": Algorithm(
        pbo.HoneyBadgerAlgorithm,
        "Swarm",
        (
            Param("beta", "float", "Food-seeking beta", 0, 10, 0.5),
            Param("C", "float", "Density constant C", 0.1, 10, 0.1),
        ),
    ),
}


def catalogue() -> dict[str, Any]:
    """JSON-ready description of every option, for `GET /api/config`."""
    return {
        "bounds": BOUNDS.tolist(),
        "functions": {
            name: {
                "optima": [list(o) for o in f.optima],
                "f_opt": f.f_opt,
                "description": f.description,
            }
            for name, f in FUNCTIONS.items()
        },
        "samplers": list(SAMPLERS),
        "strategies": list(STRATEGIES),
        "algorithms": {
            name: {
                "family": a.family,
                "params": [
                    {
                        "name": p.name,
                        "kind": p.kind,
                        "label": p.label or p.name,
                        "min": p.min,
                        "max": p.max,
                        "step": p.step,
                        "choices": list(p.choices),
                        "nullable": p.nullable,
                        "default": a.defaults()[p.name],
                    }
                    for p in a.params
                ],
            }
            for name, a in ALGORITHMS.items()
        },
    }
