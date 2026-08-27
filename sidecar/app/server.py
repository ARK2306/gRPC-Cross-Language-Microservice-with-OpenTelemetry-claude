"""Sidecar entrypoint: an asyncio gRPC server exposing PredictionService.

Startup order matters — `setup_tracing()` patches `grpc.aio.server()` to install
the OpenTelemetry server interceptor, so it must run before the server object is
created.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from concurrent.futures import ThreadPoolExecutor

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc
from grpc_reflection.v1alpha import reflection, reflection_pb2_grpc

from .cache import PredictionCache
from .config import Config, load_config
from .service import PredictionService
from .stubs import prediction_pb2, prediction_pb2_grpc
from .tracing import force_flush, setup_tracing, shutdown_tracing

log = logging.getLogger("sidecar")

SERVICE_FULL_NAME = prediction_pb2.DESCRIPTOR.services_by_name["PredictionService"].full_name
_SHUTDOWN_GRACE_SECONDS = 10.0


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        stream=sys.stdout,
    )
    # grpc.aio logs every cancelled stream at WARNING; that's normal traffic here.
    logging.getLogger("grpc").setLevel(logging.ERROR)


async def serve(config: Config) -> None:
    configure_logging(config.log_level)

    # Must precede grpc.aio.server(): the instrumentor patches that factory.
    setup_tracing(config)

    cache = PredictionCache(
        config.redis_url,
        ttl_seconds=config.cache_ttl_seconds,
        namespace=config.cache_namespace,
        enabled=config.cache_enabled,
    )
    await cache.connect()

    executor = ThreadPoolExecutor(
        max_workers=config.max_workers, thread_name_prefix="inference"
    )

    server = grpc.aio.server(
        migration_thread_pool=executor,
        maximum_concurrent_rpcs=config.max_concurrent_rpcs,
        options=[
            ("grpc.max_receive_message_length", 16 * 1024 * 1024),
            ("grpc.max_send_message_length", 16 * 1024 * 1024),
            ("grpc.keepalive_time_ms", 30_000),
            ("grpc.keepalive_timeout_ms", 10_000),
            ("grpc.keepalive_permit_without_calls", 1),
            # Node's grpc-js keepalive is 30s; without this the server would
            # send GOAWAY ENHANCE_YOUR_CALM and kill idle-but-live channels.
            ("grpc.http2.min_ping_interval_without_data_ms", 10_000),
        ],
    )

    prediction_pb2_grpc.add_PredictionServiceServicer_to_server(
        PredictionService(config, cache, executor), server
    )

    # Standard gRPC health protocol, used by the container healthcheck and by
    # docker-compose's `depends_on: service_healthy` gate.
    #
    # `health.aio.HealthServicer` — not `health.HealthServicer` — because this
    # is an asyncio server: the synchronous servicer returns a plain message
    # where grpc.aio awaits a coroutine.
    health_servicer = health.aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)

    # Server reflection lets grpcurl and friends explore the service without a
    # local copy of the .proto. `reflection.enable_server_reflection()` wires up
    # the synchronous servicer, which has the same problem as above, so the aio
    # servicer is registered directly.
    reflection_pb2_grpc.add_ServerReflectionServicer_to_server(
        reflection.aio.ReflectionServicer(
            [SERVICE_FULL_NAME, health.SERVICE_NAME, reflection.SERVICE_NAME]
        ),
        server,
    )

    server.add_insecure_port(config.bind_address)
    await server.start()

    for name in ("", SERVICE_FULL_NAME):
        await health_servicer.set(name, health_pb2.HealthCheckResponse.SERVING)

    log.info(
        "sidecar listening on %s (service=%s, redis=%s, otlp=%s)",
        config.bind_address,
        SERVICE_FULL_NAME,
        config.redis_url if config.cache_enabled else "disabled",
        config.otlp_traces_endpoint,
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    await stop.wait()
    log.info("shutdown signal received; draining in-flight RPCs")

    # Report NOT_SERVING first so load balancers stop sending new work while
    # existing RPCs drain.
    for name in ("", SERVICE_FULL_NAME):
        await health_servicer.set(name, health_pb2.HealthCheckResponse.NOT_SERVING)

    await server.stop(_SHUTDOWN_GRACE_SECONDS)
    await cache.close()
    executor.shutdown(wait=False, cancel_futures=True)
    force_flush()
    shutdown_tracing()
    log.info("shutdown complete")


def main() -> None:
    config = load_config()
    try:
        asyncio.run(serve(config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
