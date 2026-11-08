"""Helpers for system tests that need optional stacks (Grafana LGTM, moto, Shuffle)."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import TypeVar

import httpx
import pytest

T = TypeVar("T")


def require_reachable(url: str, what: str, stack: str) -> str:
    """Skip unless `url` answers, so each system test runs only where its stack is started.

    A CI job lists the stacks it starts in REQUIRE_STACKS (comma-separated). For those, an
    unreachable service is a failure, not a skip: a stack that failed to start must not turn
    the job green with nothing tested.
    """
    try:
        httpx.get(url, timeout=3.0)
    except httpx.HTTPError:
        required = {s.strip() for s in os.environ.get("REQUIRE_STACKS", "").split(",")}
        if stack in required:
            pytest.fail(f"{what} is required (REQUIRE_STACKS={stack}) but not reachable at {url}")
        pytest.skip(f"{what} is not running at {url}")
    return url


def env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def eventually(what: str, check: Callable[[], T | None], timeout_s: float = 90.0) -> T:
    """Retry `check` until it returns a value: exporters and workers deliver asynchronously."""
    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value is not None:
                return value
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as err:
            last = err
        time.sleep(2.0)
    pytest.fail(f"timed out after {timeout_s:.0f} s waiting for {what} (last error: {last})")
