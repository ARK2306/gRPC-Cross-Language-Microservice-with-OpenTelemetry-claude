"""Runtime configuration for the sidecar, read once from the environment.

Defaults are the Docker Compose values (service hostnames, not localhost), so
`docker compose up` needs no environment file. See README.md for the full table.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _str(name: str, default: str) -> str:
    value = os.getenv(name)
    return default if value is None or value == "" else value


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"environment variable {name} must be an integer, got {raw!r}") from exc
    if value <= 0:
        raise ValueError(f"environment variable {name} must be positive, got {value}")
    return value


def _float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"environment variable {name} must be a float, got {raw!r}") from exc


@dataclass(frozen=True, slots=True)
class Config:
    # --- gRPC server ---
    host: str
    port: int
    max_workers: int
    max_concurrent_rpcs: int

    # --- Redis cache ---
    redis_url: str
    cache_ttl_seconds: int
    cache_namespace: str
    cache_enabled: bool

    # --- mock model ---
    default_model: str
    min_compute_seconds: float
    max_compute_seconds: float
    matrix_dim: int
    output_dim: int

    # --- telemetry ---
    service_name: str
    service_version: str
    environment: str
    otlp_traces_endpoint: str
    log_level: str

    @property
    def bind_address(self) -> str:
        return f"{self.host}:{self.port}"


def load_config() -> Config:
    otlp_base = _str("OTEL_EXPORTER_OTLP_ENDPOINT", "http://jaeger:4318").rstrip("/")

    return Config(
        host=_str("GRPC_HOST", "0.0.0.0"),
        port=_int("GRPC_PORT", 50051),
        # Model work is numpy BLAS, which releases the GIL, so threads give real
        # parallelism here.
        max_workers=_int("GRPC_MAX_WORKERS", (os.cpu_count() or 2) * 2),
        max_concurrent_rpcs=_int("GRPC_MAX_CONCURRENT_RPCS", 64),
        redis_url=_str("REDIS_URL", "redis://redis:6379/0"),
        cache_ttl_seconds=_int("CACHE_TTL_SECONDS", 60),
        cache_namespace=_str("CACHE_NAMESPACE", "prediction:v1"),
        cache_enabled=_str("CACHE_ENABLED", "true").lower() not in {"0", "false", "no"},
        default_model=_str("DEFAULT_MODEL", "mock-mlp-v1"),
        min_compute_seconds=_float("MIN_COMPUTE_SECONDS", 1.0),
        max_compute_seconds=_float("MAX_COMPUTE_SECONDS", 2.0),
        matrix_dim=_int("MODEL_MATRIX_DIM", 256),
        output_dim=_int("MODEL_OUTPUT_DIM", 8),
        service_name=_str("OTEL_SERVICE_NAME", "prediction-sidecar"),
        service_version=_str("SERVICE_VERSION", "1.0.0"),
        environment=_str("DEPLOYMENT_ENV", "local"),
        # Docker networking resolves `jaeger`; never hardcode localhost here.
        otlp_traces_endpoint=_str(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", f"{otlp_base}/v1/traces"
        ),
        log_level=_str("LOG_LEVEL", "INFO").upper(),
    )
