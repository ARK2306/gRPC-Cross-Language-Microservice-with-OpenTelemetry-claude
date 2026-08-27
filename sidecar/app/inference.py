"""Mock ML inference.

Stands in for a real model with a numpy workload that burns 1-2 seconds of CPU
per distinct input. Two properties have to hold at once:

  * **Deterministic** — the same (model, input) must always produce the same
    output, otherwise a cache hit would return a different answer than a fresh
    computation and the cache would be silently lying.
  * **Slow** — roughly 1-2 seconds of real CPU work, so that caching is
    worth something and is observable in traces.

These pull in opposite directions, so the two concerns are separated:
`_forward()` is a fixed-depth pass whose result depends only on the request
fingerprint, and `_burn()` spends whatever remains of the time budget on
throwaway dot products. Iteration counts are never derived from elapsed time,
because that would make the output depend on how loaded the machine is.

All functions here are synchronous and CPU-bound. They are called from a
thread pool (see service.py) — numpy's BLAS dot products release the GIL, so
concurrent requests genuinely run in parallel.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Callable, Iterator, Sequence

import numpy as np


#: Layers in the deterministic forward pass. Fixed, so the output never
#: depends on how fast the host happens to be.
MODEL_DEPTH = 8


@dataclass(frozen=True, slots=True)
class ModelResult:
    output: list[float]
    score: float
    compute_ms: int
    iterations: int


def fingerprint(model: str, values: Sequence[float]) -> str:
    """Stable content hash of an inference request.

    Used both as the Redis cache key suffix and as the model's RNG seed, so a
    given (model, input) pair always produces the same prediction.

    Floats are serialised with `repr` via json to keep the digest stable across
    platforms; `separators` removes whitespace so formatting can't change it.
    """
    payload = json.dumps(
        {"model": model, "input": [float(v) for v in values]},
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _target_seconds(digest: str, lo: float, hi: float) -> float:
    """Pick this request's CPU budget deterministically from its hash."""
    if hi <= lo:
        return lo
    # 8 hex chars -> a stable fraction in [0, 1).
    fraction = int(digest[:8], 16) / 0xFFFFFFFF
    return lo + fraction * (hi - lo)


def _weights(digest: str, dim: int) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic weight matrices seeded from the request fingerprint."""
    seed = int(digest[:16], 16) % (2**32)
    rng = np.random.default_rng(seed)
    left = rng.standard_normal((dim, dim), dtype=np.float64)
    right = rng.standard_normal((dim, dim), dtype=np.float64)
    return left, right


def _project(vector: Sequence[float], dim: int) -> np.ndarray:
    """Tile/truncate an arbitrary-length input into the model's fixed width."""
    arr = np.asarray(vector, dtype=np.float64)
    if arr.size == 0:
        raise ValueError("input vector must not be empty")
    reps = int(np.ceil(dim / arr.size))
    return np.tile(arr, reps)[:dim]


def _summarise(state: np.ndarray, output_dim: int) -> tuple[list[float], float]:
    """Reduce the hidden state to a small output vector plus a scalar score."""
    # Normalise so the magnitude of the accumulated dot products doesn't leak
    # into the output as an arbitrarily large number.
    norm = float(np.linalg.norm(state)) or 1.0
    normalised = state / norm

    buckets = np.array_split(normalised, output_dim)
    output = [float(np.tanh(bucket.sum())) for bucket in buckets]

    # Softmax-style confidence over the output vector, in [1/output_dim, 1].
    exps = np.exp(np.asarray(output) - np.max(output))
    score = float(np.max(exps / exps.sum()))
    return output, score


def _forward(state: np.ndarray, left: np.ndarray, right: np.ndarray, depth: int) -> np.ndarray:
    """Fixed-depth forward pass. Deterministic given the same weights and input."""
    for _ in range(depth):
        state = np.tanh(left @ state)
        state = np.tanh(right @ state)
    return state


def _burn(state: np.ndarray, left: np.ndarray, deadline: float) -> int:
    """Spend the remaining CPU budget on dot products whose result is discarded.

    This is what makes the mock model *slow*. It is deliberately kept out of the
    result path so that wall-clock jitter cannot leak into the prediction.
    """
    scratch = state.copy()
    iterations = 0
    while time.perf_counter() < deadline:
        scratch = np.tanh(left @ scratch)
        iterations += 1
    return iterations


def run_inference(
    values: Sequence[float],
    *,
    model: str,
    digest: str,
    min_seconds: float,
    max_seconds: float,
    matrix_dim: int,
    output_dim: int,
) -> ModelResult:
    """Run the full mock model. Blocks for roughly `min_seconds`-`max_seconds`."""
    started = time.perf_counter()
    budget = _target_seconds(digest, min_seconds, max_seconds)

    left, right = _weights(digest, matrix_dim)
    state = _forward(_project(values, matrix_dim), left, right, MODEL_DEPTH)
    output, score = _summarise(state, output_dim)

    padding = _burn(state, left, started + budget)

    return ModelResult(
        output=output,
        score=score,
        compute_ms=int((time.perf_counter() - started) * 1000),
        iterations=MODEL_DEPTH + padding,
    )


def run_inference_steps(
    values: Sequence[float],
    *,
    model: str,
    digest: str,
    steps: int,
    min_seconds: float,
    max_seconds: float,
    matrix_dim: int,
    output_dim: int,
    should_stop: Callable[[], bool] | None = None,
) -> Iterator[tuple[int, float]]:
    """Incremental variant backing the server-streaming RPC.

    Yields ``(step, value)`` pairs, spreading the same total CPU budget over
    `steps` chunks so the client sees deltas arrive steadily rather than all at
    once at the end. Like `run_inference`, the emitted values are deterministic
    and only the padding is time-driven.

    `should_stop` is polled between steps; when it returns True the generator
    returns early. The caller passes a flag set on client cancellation, so an
    abandoned stream stops burning CPU instead of running to completion.
    """
    if steps <= 0:
        raise ValueError("steps must be >= 1")

    budget = _target_seconds(digest, min_seconds, max_seconds)
    per_step = budget / steps

    left, right = _weights(digest, matrix_dim)
    state = _project(values, matrix_dim)

    for step in range(1, steps + 1):
        if should_stop is not None and should_stop():
            return

        step_deadline = time.perf_counter() + per_step

        state = _forward(state, left, right, MODEL_DEPTH)
        norm = float(np.linalg.norm(state)) or 1.0
        value = float(np.tanh((state / norm).sum()))

        _burn(state, left, step_deadline)
        yield step, value
