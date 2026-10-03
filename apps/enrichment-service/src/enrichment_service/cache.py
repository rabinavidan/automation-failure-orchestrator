"""In-process TTL cache with single-flight lookups.

Threat-intel APIs are rate-limited (VirusTotal public: 4 req/min), and alert
storms repeat the same IOCs, so identical concurrent lookups share one call.
Errors are never cached.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar

T = TypeVar("T")


class LoadAbandonedError(Exception):
    """The lookup that a concurrent caller was waiting on was cancelled (e.g. timed out)."""


class TTLCache(Generic[T]):
    def __init__(self, ttl_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._values: dict[str, tuple[float, T]] = {}
        self._inflight: dict[str, asyncio.Future[T]] = {}

    def get(self, key: str) -> T | None:
        entry = self._values.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if self._clock() >= expires_at:
            del self._values[key]
            return None
        return value

    async def get_or_load(self, key: str, loader: Callable[[], Awaitable[T]]) -> tuple[T, bool]:
        """Returns ``(value, cached)``."""
        hit = self.get(key)
        if hit is not None:
            return hit, True

        pending = self._inflight.get(key)
        if pending is not None:
            return await asyncio.shield(pending), True

        future: asyncio.Future[T] = asyncio.get_running_loop().create_future()
        self._inflight[key] = future
        try:
            value = await loader()
        except asyncio.CancelledError:
            # Waiters get an ordinary exception, never another task's cancellation.
            _fail(future, LoadAbandonedError(key))
            raise
        except Exception as exc:
            _fail(future, exc)
            raise
        else:
            self._values[key] = (self._clock() + self._ttl, value)
            future.set_result(value)
            return value, False
        finally:
            del self._inflight[key]

    def clear(self) -> None:
        self._values.clear()

    def __len__(self) -> int:
        return len(self._values)


def _fail(future: asyncio.Future[T], exc: Exception) -> None:
    future.set_exception(exc)
    # Mark retrieved so a failed future nobody awaited does not log a warning.
    future.exception()
