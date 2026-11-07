"""API responses against the schemas exported from @orchestrator/shared-types.

Inbound payloads have always been validated against the shared contract; responses were plain
interfaces, re-declared by the dashboard. Now POST /api/runs and the persisted investigation have
Zod schemas too, exported as JSON Schema with unknown fields forbidden, so a field the API adds,
drops or retypes fails here before a consumer finds out.
"""

from __future__ import annotations

from typing import Any

import pytest

from support import agents, factories
from support.clients import IngestionClient, OllamaStubClient
from support.contracts import errors

pytestmark = pytest.mark.contract


def test_a_mixed_run_response_satisfies_the_contract(ingestion: IngestionClient) -> None:
    payload = factories.run_payload(
        [
            factories.result(),
            factories.result(
                error_name="Error", error_message="connect ECONNREFUSED 10.0.0.12:5432"
            ),
            factories.passed(f"tests/api/orders.spec.ts::{factories.unique('ok')}"),
        ]
    )

    body = ingestion.post_run(payload).json()

    assert errors("processing-result", body) == []
    assert len(body["failures"]) == 2


def test_a_redelivered_run_response_satisfies_the_contract(ingestion: IngestionClient) -> None:
    payload = factories.run_payload([factories.result()])
    ingestion.post_run(payload)

    body = ingestion.post_run(payload).json()

    assert body["duplicateRun"] is True
    assert errors("processing-result", body) == []


@pytest.mark.parametrize("risk", ["low", "high"], ids=["acted", "paused-for-approval"])
def test_an_investigated_run_response_satisfies_the_contract(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, risk: str
) -> None:
    stub.script(responses=agents.supervisor_run(risk=risk))

    body = ingestion_ai.post_run(factories.run_payload([factories.result()])).json()

    assert errors("processing-result", body) == []
    [failure] = body["failures"]
    investigation: dict[str, Any] = failure["agentInvestigation"]
    assert investigation["specialistReports"], "the supervisor graph reports per specialist"
    assert ("approval" in failure) is (risk == "high")


def test_the_persisted_investigation_satisfies_the_contract(
    ingestion_ai: IngestionClient, stub: OllamaStubClient
) -> None:
    stub.script(responses=agents.supervisor_run())
    [failure] = ingestion_ai.post_run(factories.run_payload([factories.result()])).json()[
        "failures"
    ]

    stored = ingestion_ai.get_failure(failure["fingerprint"]).json()

    [result] = stored["recentResults"]
    assert errors("agent-investigation", result["agent_investigation"]) == []


def test_the_contract_rejects_an_unknown_recommended_action() -> None:
    investigation = {
        "suspectedRootCause": "x",
        "evidence": [],
        "recommendedAction": "delete_repository",
        "confidence": 0.5,
        "explanation": "x",
        "toolsUsed": [],
        "model": "demo-stub",
    }
    assert errors("agent-investigation", investigation), "the exported schema should reject this"
