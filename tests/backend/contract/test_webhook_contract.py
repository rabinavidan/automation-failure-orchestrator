"""The webhook contract, checked from outside TypeScript.

The JSON Schema is generated from the Zod schema the API validates with, so these tests pin
the same rules for every producer: the Playwright reporter, n8n, CI scripts, other languages.
"""

from __future__ import annotations

from typing import Any

import pytest

from support import factories
from support.clients import IngestionClient
from support.contracts import errors

pytestmark = pytest.mark.contract


def test_factories_produce_contract_valid_payloads() -> None:
    payload = factories.run_payload([factories.result(), factories.passed("tests/a.spec.ts::ok")])
    assert errors("webhook-payload", payload) == []


def _without(payload: dict[str, Any], field: str) -> dict[str, Any]:
    return {k: v for k, v in payload.items() if k != field}


INVALID: dict[str, Any] = {
    "missing runId": lambda p: _without(p, "runId"),
    "missing tests": lambda p: _without(p, "tests"),
    "timestamp without timezone": lambda p: {**p, "startedAt": "2026-11-02T10:00:00"},
    "unknown test status": lambda p: {**p, "tests": [{**p["tests"][0], "status": "broken"}]},
    "artifact path instead of URL": lambda p: {
        **p,
        "tests": [{**p["tests"][0], "artifacts": {"screenshotUrl": "test-results/shot.png"}}],
    },
    "non-numeric duration": lambda p: {
        **p,
        "tests": [{**p["tests"][0], "durationMs": "fast"}],
    },
}


@pytest.mark.parametrize("mutate", INVALID.values(), ids=INVALID.keys())
def test_schema_and_api_reject_the_same_invalid_payloads(
    ingestion: IngestionClient, mutate: Any
) -> None:
    payload = mutate(factories.run_payload([factories.result()]))

    assert errors("webhook-payload", payload), "the exported schema should reject this"
    response = ingestion.post_run(payload)
    assert response.status_code == 400
    assert response.json()["error"] == "Invalid payload"
