import asyncio

import pytest

from enrichment_service.cache import LoadAbandonedError, TTLCache


async def test_caches_until_ttl_expires() -> None:
    now = [0.0]
    cache: TTLCache[str] = TTLCache(10, clock=lambda: now[0])
    calls = 0

    async def load() -> str:
        nonlocal calls
        calls += 1
        return "v"

    assert await cache.get_or_load("k", load) == ("v", False)
    assert await cache.get_or_load("k", load) == ("v", True)
    now[0] = 10.0
    assert await cache.get_or_load("k", load) == ("v", False)
    assert calls == 2


async def test_concurrent_identical_lookups_share_one_call() -> None:
    cache: TTLCache[str] = TTLCache(60)
    calls = 0
    gate = asyncio.Event()

    async def load() -> str:
        nonlocal calls
        calls += 1
        await gate.wait()
        return "v"

    tasks = [asyncio.create_task(cache.get_or_load("k", load)) for _ in range(5)]
    await asyncio.sleep(0)
    gate.set()
    results = await asyncio.gather(*tasks)
    assert calls == 1
    assert [cached for _, cached in results].count(False) == 1


async def test_errors_are_not_cached() -> None:
    cache: TTLCache[str] = TTLCache(60)

    async def boom() -> str:
        raise RuntimeError("upstream down")

    with pytest.raises(RuntimeError):
        await cache.get_or_load("k", boom)
    assert len(cache) == 0


async def test_waiters_get_plain_error_when_leader_is_cancelled() -> None:
    cache: TTLCache[str] = TTLCache(60)

    async def slow() -> str:
        await asyncio.sleep(10)
        return "v"

    leader = asyncio.create_task(cache.get_or_load("k", slow))
    await asyncio.sleep(0)
    waiter = asyncio.create_task(cache.get_or_load("k", slow))
    await asyncio.sleep(0)
    leader.cancel()
    with pytest.raises(LoadAbandonedError):
        await waiter
