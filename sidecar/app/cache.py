"""Redis-backed result cache.

Keyed by a SHA-256 fingerprint of (model, input) so identical requests skip the
1-2 second model run. Entries expire after CACHE_TTL_SECONDS (60 by default).

Every operation is fail-open: Redis being down degrades the service to
"always recompute", never to "return an error". A cache is not a dependency
worth failing requests over.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from .inference import ModelResult

log = logging.getLogger(__name__)


class PredictionCache:
    def __init__(
        self,
        url: str,
        *,
        ttl_seconds: int,
        namespace: str,
        enabled: bool = True,
    ) -> None:
        self._ttl = ttl_seconds
        self._namespace = namespace
        self._enabled = enabled
        self._client: aioredis.Redis | None = None
        self._url = url

    async def connect(self) -> None:
        if not self._enabled:
            log.info("cache disabled by configuration")
            return
        self._client = aioredis.from_url(
            self._url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
            health_check_interval=30,
        )
        try:
            await self._client.ping()
            log.info("connected to redis at %s (ttl=%ss)", self._url, self._ttl)
        except RedisError:
            # Don't fail startup: the sidecar is still fully functional without
            # a cache, and Redis may simply be a moment behind us in booting.
            log.warning("redis unreachable at %s; running without cache", self._url, exc_info=True)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def key(self, digest: str) -> str:
        return f"{self._namespace}:{digest}"

    async def get(self, digest: str) -> ModelResult | None:
        if self._client is None:
            return None
        try:
            raw = await self._client.get(self.key(digest))
        except RedisError:
            log.warning("redis GET failed; treating as a miss", exc_info=True)
            return None
        if raw is None:
            return None
        try:
            payload: dict[str, Any] = json.loads(raw)
            return ModelResult(
                output=[float(v) for v in payload["output"]],
                score=float(payload["score"]),
                compute_ms=int(payload["compute_ms"]),
                iterations=int(payload["iterations"]),
            )
        except (ValueError, KeyError, TypeError):
            # A malformed entry (bad write, schema change) must not be fatal.
            log.warning("discarding malformed cache entry for %s", digest, exc_info=True)
            return None

    async def set(self, digest: str, result: ModelResult) -> None:
        if self._client is None:
            return
        try:
            await self._client.set(
                self.key(digest), json.dumps(asdict(result)), ex=self._ttl
            )
        except RedisError:
            log.warning("redis SET failed; result not cached", exc_info=True)

    async def ping(self) -> bool:
        """Used by the health check to report cache availability."""
        if self._client is None:
            return False
        try:
            return bool(await self._client.ping())
        except RedisError:
            return False

    @property
    def enabled(self) -> bool:
        return self._enabled
