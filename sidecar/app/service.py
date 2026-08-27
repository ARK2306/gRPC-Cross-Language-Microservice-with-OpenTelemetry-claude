"""PredictionService implementation.

Both RPCs follow the same shape: validate, hash the input, consult Redis, and
only then hand the CPU-bound numpy work to a thread pool so the asyncio event
loop stays responsive while a 1-2 second inference runs.
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import AsyncIterator, Sequence

import grpc
from opentelemetry import trace
from opentelemetry.trace import SpanKind, StatusCode

from .cache import PredictionCache
from .config import Config
from .inference import fingerprint, run_inference, run_inference_steps
from .stubs import prediction_pb2, prediction_pb2_grpc

log = logging.getLogger(__name__)

MAX_INPUT_LEN = 4096
MAX_STEPS = 100
DEFAULT_STEPS = 5


class PredictionService(prediction_pb2_grpc.PredictionServiceServicer):
    def __init__(
        self,
        config: Config,
        cache: PredictionCache,
        executor: ThreadPoolExecutor,
    ) -> None:
        self._config = config
        self._cache = cache
        self._executor = executor
        self._tracer = trace.get_tracer(config.service_name, config.service_version)
        # Bounds how much CPU work is in flight regardless of how many RPCs
        # arrive; without it a burst would thrash the thread pool.
        self._inflight = asyncio.Semaphore(config.max_concurrent_rpcs)

    # ------------------------------------------------------------------ utils

    async def _validate(
        self, values: Sequence[float], context: grpc.aio.ServicerContext
    ) -> None:
        """Reject malformed inputs with INVALID_ARGUMENT before doing any work."""
        if len(values) == 0:
            await self._abort(context, "input must not be empty")
        if len(values) > MAX_INPUT_LEN:
            await self._abort(
                context,
                f"input must contain at most {MAX_INPUT_LEN} values, got {len(values)}",
            )
        if not all(math.isfinite(v) for v in values):
            await self._abort(context, "input must contain only finite numbers")

    @staticmethod
    async def _abort(context: grpc.aio.ServicerContext, detail: str) -> None:
        """Abort with INVALID_ARGUMENT, recording the failure on the span first.

        `context.abort` raises, so the span status has to be set beforehand or
        the span is exported as OK despite the call failing.
        """
        trace.get_current_span().set_status(StatusCode.ERROR, detail)
        await context.abort(grpc.StatusCode.INVALID_ARGUMENT, detail)

    async def _in_thread(self, fn, /, *args, **kwargs):
        """Run blocking numpy work off the event loop."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, lambda: fn(*args, **kwargs))

    # ------------------------------------------------------------------- RPCs

    async def Predict(
        self,
        request: prediction_pb2.PredictRequest,
        context: grpc.aio.ServicerContext,
    ) -> prediction_pb2.PredictResponse:
        values = list(request.input)
        await self._validate(values, context)

        model = request.model or self._config.default_model
        digest = fingerprint(model, values)
        cache_key = self._cache.key(digest)

        span = trace.get_current_span()
        span.set_attributes(
            {
                "prediction.model": model,
                "prediction.input_size": len(values),
                "prediction.cache_key": cache_key,
                "prediction.request_id": request.request_id,
            }
        )

        async with self._inflight:
            cached = await self._cache.get(digest)
            if cached is not None:
                span.set_attribute("prediction.cached", True)
                log.info(
                    "cache hit model=%s key=%s request_id=%s", model, cache_key, request.request_id
                )
                return prediction_pb2.PredictResponse(
                    output=cached.output,
                    score=cached.score,
                    model=model,
                    cached=True,
                    cache_key=cache_key,
                    compute_ms=0,
                    request_id=request.request_id,
                )

            span.set_attribute("prediction.cached", False)

            with self._tracer.start_as_current_span(
                "model.infer", kind=SpanKind.INTERNAL
            ) as model_span:
                result = await self._in_thread(
                    run_inference,
                    values,
                    model=model,
                    digest=digest,
                    min_seconds=self._config.min_compute_seconds,
                    max_seconds=self._config.max_compute_seconds,
                    matrix_dim=self._config.matrix_dim,
                    output_dim=self._config.output_dim,
                )
                model_span.set_attributes(
                    {
                        "model.compute_ms": result.compute_ms,
                        "model.iterations": result.iterations,
                        "model.matrix_dim": self._config.matrix_dim,
                    }
                )

            await self._cache.set(digest, result)

        log.info(
            "cache miss model=%s key=%s compute_ms=%d request_id=%s",
            model,
            cache_key,
            result.compute_ms,
            request.request_id,
        )
        return prediction_pb2.PredictResponse(
            output=result.output,
            score=result.score,
            model=model,
            cached=False,
            cache_key=cache_key,
            compute_ms=result.compute_ms,
            request_id=request.request_id,
        )

    async def StreamPredictions(
        self,
        request: prediction_pb2.StreamRequest,
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[prediction_pb2.PredictionDelta]:
        values = list(request.input)
        await self._validate(values, context)

        steps = request.steps or DEFAULT_STEPS
        if steps > MAX_STEPS:
            steps = MAX_STEPS

        model = request.model or self._config.default_model
        digest = fingerprint(model, values)

        span = trace.get_current_span()
        span.set_attributes(
            {
                "prediction.model": model,
                "prediction.input_size": len(values),
                "prediction.steps": steps,
                "prediction.request_id": request.request_id,
                "prediction.streaming": True,
            }
        )

        started = time.perf_counter()
        cumulative = 0.0
        emitted = 0

        # The generator is CPU-bound, so it runs on a worker thread and hands
        # items back through a queue.
        #
        # The queue is unbounded and the producer publishes with
        # call_soon_threadsafe, so the worker thread never blocks on the event
        # loop. A bounded queue would give backpressure, but at the cost of
        # leaking the worker: cancelling a running run_in_executor future does
        # nothing, so a producer parked on a full queue after the consumer went
        # away would stay parked forever. Backpressure is not needed here
        # anyway — each step costs (budget / steps) seconds of CPU and steps is
        # capped at 100, so the producer cannot outrun the consumer.
        #
        # `cancelled` is what actually stops the work: the generator polls it
        # between steps and returns early.
        queue: asyncio.Queue[tuple[int, float] | None | Exception] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        cancelled = threading.Event()

        def publish(item: tuple[int, float] | None | Exception) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, item)

        def produce() -> None:
            try:
                for step, value in run_inference_steps(
                    values,
                    model=model,
                    digest=digest,
                    steps=steps,
                    min_seconds=self._config.min_compute_seconds,
                    max_seconds=self._config.max_compute_seconds,
                    matrix_dim=self._config.matrix_dim,
                    output_dim=self._config.output_dim,
                    should_stop=cancelled.is_set,
                ):
                    publish((step, value))
            except Exception as exc:  # noqa: BLE001 - forwarded to the consumer
                publish(exc)
            else:
                publish(None)

        async with self._inflight:
            loop.run_in_executor(self._executor, produce)
            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        break
                    if isinstance(item, Exception):
                        raise item

                    step, value = item
                    cumulative += value
                    emitted += 1
                    yield prediction_pb2.PredictionDelta(
                        step=step,
                        total_steps=steps,
                        value=value,
                        cumulative=cumulative,
                        final=step == steps,
                        request_id=request.request_id,
                    )
            except asyncio.CancelledError:
                # Client hung up. Expected; don't log it as a failure.
                log.info(
                    "stream cancelled after %d/%d deltas request_id=%s",
                    emitted,
                    steps,
                    request.request_id,
                )
                raise
            except Exception:
                span.set_status(StatusCode.ERROR, "streaming inference failed")
                log.exception("stream failed request_id=%s", request.request_id)
                await context.abort(grpc.StatusCode.INTERNAL, "streaming inference failed")
            finally:
                # Signals the worker to stop between steps; it then drains
                # naturally instead of being abandoned mid-computation.
                cancelled.set()

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        span.set_attributes({"prediction.deltas_emitted": emitted, "prediction.elapsed_ms": elapsed_ms})
        log.info(
            "stream complete deltas=%d elapsed_ms=%d request_id=%s",
            emitted,
            elapsed_ms,
            request.request_id,
        )
