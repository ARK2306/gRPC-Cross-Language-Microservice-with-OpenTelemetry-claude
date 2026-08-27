"""Unit tests for the Redis-backed result cache.

Runs against a real Redis when REDIS_URL points at one (CI and the local
Compose stack both do); otherwise the connection-dependent tests are skipped
and only the fail-open behaviour is exercised.
"""

from __future__ import annotations

import os
import uuid

import pytest

from app.cache import PredictionCache
from app.inference import ModelResult

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

RESULT = ModelResult(output=[0.1, -0.2, 0.3], score=0.42, compute_ms=1234, iterations=7)


def digest() -> str:
    """A fresh key per test, so runs cannot contaminate each other."""
    return uuid.uuid4().hex * 2  # 64 hex chars, same shape as a sha256 digest


@pytest.fixture
async def cache():
    instance = PredictionCache(REDIS_URL, ttl_seconds=60, namespace="test:prediction")
    await instance.connect()
    if not await instance.ping():
        await instance.close()
        pytest.skip(f"no Redis at {REDIS_URL}")
    yield instance
    await instance.close()


class TestKey:
    def test_key_is_namespaced(self):
        instance = PredictionCache(REDIS_URL, ttl_seconds=60, namespace="ns")
        assert instance.key("abc") == "ns:abc"


class TestRoundTrip:
    async def test_miss_returns_none(self, cache):
        assert await cache.get(digest()) is None

    async def test_set_then_get_round_trips_every_field(self, cache):
        key = digest()
        await cache.set(key, RESULT)
        loaded = await cache.get(key)

        assert loaded is not None
        assert loaded.output == RESULT.output
        assert loaded.score == RESULT.score
        assert loaded.compute_ms == RESULT.compute_ms
        assert loaded.iterations == RESULT.iterations

    async def test_entries_expire_with_the_configured_ttl(self, cache):
        key = digest()
        await cache.set(key, RESULT)
        # Assert the TTL is applied rather than sleeping out a 60s expiry.
        ttl = await cache._client.ttl(cache.key(key))  # noqa: SLF001 - white-box on purpose
        assert 0 < ttl <= 60

    async def test_malformed_entries_are_treated_as_a_miss(self, cache):
        key = digest()
        await cache._client.set(cache.key(key), "not json")  # noqa: SLF001
        assert await cache.get(key) is None


class TestFailOpen:
    """A cache outage must degrade to recomputation, never to an error."""

    async def test_disabled_cache_is_inert(self):
        instance = PredictionCache(REDIS_URL, ttl_seconds=60, namespace="ns", enabled=False)
        await instance.connect()
        assert instance.enabled is False
        assert await instance.get(digest()) is None
        await instance.set(digest(), RESULT)  # must not raise
        assert await instance.ping() is False
        await instance.close()

    async def test_unreachable_redis_does_not_raise(self):
        # Port 1 is reserved and refuses connections immediately.
        instance = PredictionCache("redis://127.0.0.1:1/0", ttl_seconds=60, namespace="ns")
        await instance.connect()
        assert await instance.get(digest()) is None
        await instance.set(digest(), RESULT)  # must not raise
        assert await instance.ping() is False
        await instance.close()
