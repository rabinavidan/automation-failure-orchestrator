"""The single-agent tool-calling graph (failure-agent-v1), with tool calls scripted through
the stub: evidence tools, the tool budget, fail-safe fallback and the no-thinking rule."""

from __future__ import annotations

from typing import Any

import pytest

from conftest import Database
from support import factories
from support.clients import IngestionClient, MockIntegrationsClient, OllamaStubClient

pytestmark = pytest.mark.agents

FINAL = {
    "suspectedRootCause": "POST /api/orders returns 500 after the payment client upgrade",
    "evidence": ["Expected 201, received 500", "first seen in this run"],
    "recommendedAction": "create_issue",
    "confidence": 0.74,
    "explanation": "New server error with no history and no tracked issue",
}


def tool_call(name: str, **arguments: Any) -> dict[str, Any]:
    return {"tool_calls": [{"function": {"name": name, "arguments": arguments}}]}


def _investigate(
    client: IngestionClient, stub: OllamaStubClient, replies: list[Any]
) -> dict[str, Any]:
    stub.script(responses=replies)
    response = client.post_run(factories.run_payload([factories.result()]))
    assert response.status_code == 201, response.text
    [failure] = response.json()["failures"]
    return dict(failure)


def test_agent_calls_evidence_tools_then_answers(
    ingestion_single_agent: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
) -> None:
    replies = [
        tool_call("get_failure_history"),
        tool_call("get_related_jira_issue"),
        FINAL,
    ]

    failure = _investigate(ingestion_single_agent, stub, replies)

    investigation = failure["agentInvestigation"]
    assert investigation["toolsUsed"] == ["get_failure_history", "get_related_jira_issue"]
    assert investigation["recommendedAction"] == "create_issue"
    assert investigation["confidence"] == pytest.approx(0.74)
    calls = stub.state()["calls"]
    assert len(calls) == 3
    assert {"get_failure_history", "get_related_jira_issue"} <= set(calls[0]["tools"])


def test_every_model_call_disables_hidden_reasoning(
    ingestion_single_agent: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
) -> None:
    """Regression: without think=false, a 'thinking' model ran past fetch's 300 s timeout
    and 62% of the single-agent benchmark runs failed."""
    _investigate(ingestion_single_agent, stub, [tool_call("get_failure_history"), FINAL])

    assert [c["think"] for c in stub.state()["calls"]] == [False, False]


def test_tool_budget_forces_a_final_answer(
    ingestion_single_agent: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
) -> None:
    """A model that keeps calling tools is cut off after four steps and asked to conclude."""
    replies: list[Any] = [tool_call("get_failure_history") for _ in range(4)] + [FINAL]

    failure = _investigate(ingestion_single_agent, stub, replies)

    assert failure["agentInvestigation"]["suspectedRootCause"] == FINAL["suspectedRootCause"]
    assert len(stub.state()["calls"]) == 5


@pytest.mark.parametrize(
    "bad_final",
    ["not JSON", {**FINAL, "confidence": 3}, {**FINAL, "recommendedAction": "deploy"}],
    ids=["not-json", "confidence-out-of-range", "unknown-action"],
)
def test_invalid_final_answer_falls_back_to_deterministic_processing(
    ingestion_single_agent: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
    bad_final: Any,
) -> None:
    failure = _investigate(ingestion_single_agent, stub, [bad_final])

    assert len(stub.state()["calls"]) >= 1
    assert failure.get("agentInvestigation") is None
    assert failure["jiraKey"] is not None


def test_execution_is_recorded_as_single_agent(
    ingestion_single_agent: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
    db: Database,
) -> None:
    failure = _investigate(ingestion_single_agent, stub, [FINAL])

    timeline = (
        ingestion_single_agent.get(f"/api/failures/{failure['fingerprint']}/agent-executions")
        .raise_for_status()
        .json()
    )
    assert timeline["executions"][0]["orchestration"] == "single_agent"
