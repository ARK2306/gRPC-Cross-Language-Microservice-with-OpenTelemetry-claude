"""Container healthcheck: probe the gRPC health service and exit 0/1.

Used as the sidecar's Docker HEALTHCHECK. Written in Python so the image does
not have to ship grpc_health_probe (or curl) just to answer "am I serving?".
"""

from __future__ import annotations

import sys

import grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc

from .config import load_config


def main() -> int:
    config = load_config()
    target = f"127.0.0.1:{config.port}"
    try:
        with grpc.insecure_channel(target) as channel:
            stub = health_pb2_grpc.HealthStub(channel)
            response = stub.Check(health_pb2.HealthCheckRequest(service=""), timeout=3)
    except grpc.RpcError as exc:
        print(f"health check failed for {target}: {exc.code()}: {exc.details()}", file=sys.stderr)
        return 1

    if response.status != health_pb2.HealthCheckResponse.SERVING:
        print(
            f"health check: {health_pb2.HealthCheckResponse.ServingStatus.Name(response.status)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
