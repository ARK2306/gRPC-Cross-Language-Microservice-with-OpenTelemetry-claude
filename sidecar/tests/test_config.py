"""Configuration parsing: defaults, overrides and validation."""

from __future__ import annotations

import pytest

from app.config import load_config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Start each test from a known-empty environment."""
    for name in (
        "GRPC_HOST", "GRPC_PORT", "REDIS_URL", "CACHE_TTL_SECONDS", "CACHE_ENABLED",
        "OTEL_SERVICE_NAME", "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "LOG_LEVEL", "MIN_COMPUTE_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


class TestDefaults:
    def test_defaults_target_the_compose_network(self):
        """Defaults must be Docker service names, never localhost."""
        config = load_config()
        assert config.bind_address == "0.0.0.0:50051"
        assert config.redis_url == "redis://redis:6379/0"
        assert config.otlp_traces_endpoint == "http://jaeger:4318/v1/traces"
        assert config.cache_ttl_seconds == 60
        assert config.service_name == "prediction-sidecar"


class TestOverrides:
    def test_env_overrides_are_applied(self, monkeypatch):
        monkeypatch.setenv("GRPC_PORT", "6000")
        monkeypatch.setenv("REDIS_URL", "redis://elsewhere:6379/3")
        monkeypatch.setenv("CACHE_TTL_SECONDS", "5")
        config = load_config()
        assert config.port == 6000
        assert config.redis_url == "redis://elsewhere:6379/3"
        assert config.cache_ttl_seconds == 5

    def test_traces_endpoint_is_derived_from_the_otlp_base(self, monkeypatch):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/")
        assert load_config().otlp_traces_endpoint == "http://collector:4318/v1/traces"

    def test_explicit_traces_endpoint_wins(self, monkeypatch):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://other/v1/traces")
        assert load_config().otlp_traces_endpoint == "http://other/v1/traces"

    @pytest.mark.parametrize("value,expected", [("false", False), ("0", False), ("no", False), ("true", True)])
    def test_cache_can_be_disabled(self, monkeypatch, value, expected):
        monkeypatch.setenv("CACHE_ENABLED", value)
        assert load_config().cache_enabled is expected


class TestValidation:
    def test_a_non_integer_port_is_rejected(self, monkeypatch):
        monkeypatch.setenv("GRPC_PORT", "not-a-port")
        with pytest.raises(ValueError, match="GRPC_PORT"):
            load_config()

    def test_a_non_positive_port_is_rejected(self, monkeypatch):
        monkeypatch.setenv("GRPC_PORT", "0")
        with pytest.raises(ValueError, match="positive"):
            load_config()

    def test_a_non_float_duration_is_rejected(self, monkeypatch):
        monkeypatch.setenv("MIN_COMPUTE_SECONDS", "slow")
        with pytest.raises(ValueError, match="MIN_COMPUTE_SECONDS"):
            load_config()
