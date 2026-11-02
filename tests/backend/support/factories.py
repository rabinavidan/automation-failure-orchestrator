"""Builders for contract-valid payloads.

Every builder output is validated against the exported JSON Schema in the contract tests, so a
factory can never drift from the real contract. Identifiers are unique per call: tests stay
independent without truncating shared tables, and can run in any order.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

Json = dict[str, Any]


def unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def result(
    *,
    status: str = "failed",
    test_id: str | None = None,
    title: str = "create order returns 201",
    retry: int = 0,
    error_name: str = "AssertionError",
    error_message: str = "Expected 201, received 500",
    service: str = "orders-service",
    endpoint: str = "/api/orders",
    severity: str = "high",
    **overrides: Any,
) -> Json:
    """One test result. Failed by default, with a unique testId (so a fresh fingerprint)."""
    result: Json = {
        "testId": test_id or f"tests/api/orders.spec.ts::{unique('create-order')}",
        "title": title,
        "suite": "Orders API",
        "file": "tests/api/orders.spec.ts",
        "status": status,
        "durationMs": 812,
        "retry": retry,
        "metadata": {"service": service, "endpoint": endpoint, "severity": severity},
    }
    if status == "failed":
        result["error"] = {"name": error_name, "message": error_message}
    result.update(overrides)
    return result


def passed(test_id: str, **overrides: Any) -> Json:
    return result(status="passed", test_id=test_id, **overrides)


def run_payload(tests: list[Json], **overrides: Any) -> Json:
    """A webhook payload for POST /api/runs, summary computed from `tests`."""
    finished = datetime.now(UTC)
    payload: Json = {
        "schemaVersion": "1.0.0",
        "runId": str(uuid.uuid4()),
        "repository": "acme/shop",
        "branch": "main",
        "commitSha": uuid.uuid4().hex + uuid.uuid4().hex[:8],
        "environment": "staging",
        "triggeredBy": "pytest",
        "startedAt": _iso(finished - timedelta(seconds=30)),
        "finishedAt": _iso(finished),
        "summary": {
            "total": len(tests),
            "passed": sum(t["status"] == "passed" for t in tests),
            "failed": sum(t["status"] == "failed" for t in tests),
            "skipped": sum(t["status"] == "skipped" for t in tests),
        },
        "tests": tests,
    }
    payload.update(overrides)
    return payload


def jira_label(fingerprint: str) -> str:
    """The Jira label the orchestrator uses for exact fingerprint correlation."""
    return f"automation-fingerprint-{fingerprint[:12]}"
