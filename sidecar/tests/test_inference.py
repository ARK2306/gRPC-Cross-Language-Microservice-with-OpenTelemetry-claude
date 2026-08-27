"""Unit tests for the mock model.

These run without Redis, gRPC or a collector: they cover the pure functions
that the RPC handlers delegate to.
"""

from __future__ import annotations

import math
import time

import pytest

from app.inference import (
    ModelResult,
    fingerprint,
    run_inference,
    run_inference_steps,
)

MODEL = "test-model"
# A small matrix keeps the suite fast; the 1-2 s budget is asserted separately.
FAST = dict(min_seconds=0.05, max_seconds=0.05, matrix_dim=32, output_dim=8)


def digest_for(values, model=MODEL):
    return fingerprint(model, values)


class TestFingerprint:
    def test_is_stable_across_calls(self):
        assert digest_for([1, 2, 3]) == digest_for([1, 2, 3])

    def test_is_a_sha256_hex_digest(self):
        assert len(digest_for([1.0])) == 64
        assert set(digest_for([1.0])) <= set("0123456789abcdef")

    def test_int_and_float_inputs_agree(self):
        # JSON round-trips both as numbers; 1 and 1.0 must not split the cache.
        assert digest_for([1, 2, 3]) == digest_for([1.0, 2.0, 3.0])

    def test_distinguishes_inputs(self):
        assert digest_for([1, 2, 3]) != digest_for([1, 2, 4])

    def test_distinguishes_order(self):
        assert digest_for([1, 2, 3]) != digest_for([3, 2, 1])

    def test_distinguishes_models(self):
        assert digest_for([1, 2, 3], "a") != digest_for([1, 2, 3], "b")


class TestRunInference:
    def test_returns_a_well_formed_result(self):
        result = run_inference([1, 2, 3], model=MODEL, digest=digest_for([1, 2, 3]), **FAST)

        assert isinstance(result, ModelResult)
        assert len(result.output) == FAST["output_dim"]
        assert all(math.isfinite(v) for v in result.output)
        # tanh-bounded
        assert all(-1.0 <= v <= 1.0 for v in result.output)
        assert 0.0 < result.score <= 1.0
        assert result.iterations >= 1
        assert result.compute_ms >= 0

    def test_is_deterministic_for_the_same_digest(self):
        values = [0.5, -1.25, 3.0]
        digest = digest_for(values)
        first = run_inference(values, model=MODEL, digest=digest, **FAST)
        second = run_inference(values, model=MODEL, digest=digest, **FAST)

        assert first.output == second.output
        assert first.score == second.score

    def test_different_inputs_give_different_outputs(self):
        a = run_inference([1, 2, 3], model=MODEL, digest=digest_for([1, 2, 3]), **FAST)
        b = run_inference([9, 8, 7], model=MODEL, digest=digest_for([9, 8, 7]), **FAST)
        assert a.output != b.output

    @pytest.mark.parametrize("values", [[1.0], [1.0] * 5, list(range(100))])
    def test_accepts_any_input_length(self, values):
        result = run_inference(values, model=MODEL, digest=digest_for(values), **FAST)
        assert len(result.output) == FAST["output_dim"]

    def test_rejects_an_empty_input(self):
        with pytest.raises(ValueError):
            run_inference([], model=MODEL, digest=digest_for([]), **FAST)

    def test_spends_the_configured_cpu_budget(self):
        """The mock model must actually be slow — the cache depends on it."""
        started = time.perf_counter()
        result = run_inference(
            [1, 2, 3],
            model=MODEL,
            digest=digest_for([1, 2, 3]),
            min_seconds=1.0,
            max_seconds=2.0,
            matrix_dim=128,
            output_dim=8,
        )
        elapsed = time.perf_counter() - started

        assert 1.0 <= elapsed < 3.0, f"expected a 1-2s run, took {elapsed:.2f}s"
        assert result.compute_ms >= 1000


class TestRunInferenceSteps:
    def test_emits_exactly_the_requested_number_of_steps(self):
        steps = list(
            run_inference_steps(
                [1, 2, 3], model=MODEL, digest=digest_for([1, 2, 3]), steps=4, **FAST
            )
        )
        assert [s for s, _ in steps] == [1, 2, 3, 4]
        assert all(math.isfinite(v) for _, v in steps)

    def test_is_deterministic(self):
        digest = digest_for([2, 4])
        args = dict(model=MODEL, digest=digest, steps=3, **FAST)
        first = list(run_inference_steps([2, 4], **args))
        second = list(run_inference_steps([2, 4], **args))
        assert first == second

    def test_rejects_a_non_positive_step_count(self):
        with pytest.raises(ValueError):
            list(
                run_inference_steps(
                    [1, 2], model=MODEL, digest=digest_for([1, 2]), steps=0, **FAST
                )
            )
