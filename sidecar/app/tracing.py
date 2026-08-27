"""OpenTelemetry bootstrap for the sidecar.

Spans go to the Jaeger collector over OTLP/HTTP
(http://jaeger:4318/v1/traces by default). The gRPC *aio server* instrumentor
extracts the W3C traceparent the Node gateway injects into call metadata, so
sidecar spans join the gateway's trace instead of starting a new one.

`instrument()` must run before `grpc.aio.server()` is constructed: the
instrumentor works by patching that factory to install its interceptor.
"""

from __future__ import annotations

import logging

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.grpc import GrpcAioInstrumentorServer
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config

log = logging.getLogger(__name__)

_provider: TracerProvider | None = None


def setup_tracing(config: Config) -> trace.Tracer:
    """Install the tracer provider and gRPC/Redis instrumentation."""
    global _provider

    resource = Resource.create(
        {
            "service.name": config.service_name,
            "service.version": config.service_version,
            "deployment.environment.name": config.environment,
        }
    )

    exporter = OTLPSpanExporter(endpoint=config.otlp_traces_endpoint, timeout=10)

    # A short delay keeps /trace-test's Jaeger polling from having to wait out
    # the default 5 s batch window on the sidecar side.
    _provider = TracerProvider(resource=resource)
    _provider.add_span_processor(
        BatchSpanProcessor(
            exporter,
            schedule_delay_millis=500,
            max_export_batch_size=512,
            max_queue_size=2048,
        )
    )
    trace.set_tracer_provider(_provider)

    # Patches grpc.aio.server(); must happen before the server is created.
    GrpcAioInstrumentorServer().instrument()
    RedisInstrumentor().instrument()

    log.info("tracing enabled: exporting to %s", config.otlp_traces_endpoint)
    return trace.get_tracer(config.service_name, config.service_version)


def force_flush(timeout_millis: int = 5000) -> None:
    if _provider is not None:
        _provider.force_flush(timeout_millis)


def shutdown_tracing() -> None:
    if _provider is not None:
        _provider.shutdown()
