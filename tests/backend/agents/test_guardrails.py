"""Advisory agents: code-owned guardrails decide what the model's advice is allowed to do.

Model replies are scripted through the stub, so these tests exercise the code around the model.
Real-model quality is measured by the benchmark, not here.
"""

from __future__ import annotations

from typing import Any

import pytest

from conftest import Database
from support import agents, factories
from support.clients import IngestionClient, MockIntegrationsClient, OllamaStubClient

pytestmark = pytest.mark.agents


def _investigate(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, replies: list[Any]
) -> dict[str, Any]:
    stub.script(responses=replies)
    response = ingestion_ai.post_run(factories.run_payload([factories.result()]))
    assert response.status_code == 201, response.text
    [failure] = response.json()["failures"]
    return dict(failure)


@pytest.mark.parametrize(
    ("proposed", "risk", "reason"),
    [
        ("create_issue", "high", "action specialist assessed risk as high"),
        ("human_review", "low", "action specialist proposed human_review"),
    ],
)
def test_guardrail_forces_human_review_and_pauses_all_side_effects(
    ingestion_ai: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
    proposed: str,
    risk: str,
    reason: str,
) -> None:
    failure = _investigate(ingestion_ai, stub, agents.supervisor_run(proposed=proposed, risk=risk))

    investigation = failure["agentInvestigation"]
    assert investigation["recommendedAction"] == "human_review"
    assert investigation["guardrailOverride"] == {"from": "create_issue", "reason": reason}
    assert failure["approval"]["status"] == "pending"
    assert mock.jira_issues() == [], "no Jira issue before a human decision"
    assert mock.slack_messages() == []
    assert len(stub.state()["calls"]) == 4


def test_low_risk_advice_does_not_pause_the_deterministic_action(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    failure = _investigate(ingestion_ai, stub, agents.supervisor_run())

    assert "approval" not in failure
    assert failure["agentInvestigation"]["recommendedAction"] == "create_issue"
    assert "guardrailOverride" not in failure["agentInvestigation"]
    assert failure["jiraKey"] is not None


def test_advice_never_overrides_the_deterministic_classification(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    """The model suggests notify_only for a new regression; policy still opens the issue."""
    failure = _investigate(
        ingestion_ai, stub, agents.supervisor_run(proposed="notify_only", recommended="notify_only")
    )

    assert failure["classification"] == "new_regression"
    assert failure["agentInvestigation"]["recommendedAction"] == "notify_only"
    assert len(mock.jira_issues(label=factories.jira_label(failure["fingerprint"]))) == 1


@pytest.mark.parametrize(
    "bad_reply",
    [
        "this is not JSON",
        {
            "suspectedRootCause": "x",
            "evidence": ["y"],
            "recommendedAction": "create_issue",
            "confidence": 1.7,
            "explanation": "confidence out of range",
        },
        {
            "suspectedRootCause": "x",
            "evidence": [],
            "recommendedAction": "create_issue",
            "confidence": 0.5,
            "explanation": "empty evidence",
        },
        {
            "suspectedRootCause": "x",
            "evidence": ["y"],
            "recommendedAction": "delete_repo",
            "confidence": 0.5,
            "explanation": "action outside the allowed set",
        },
    ],
    ids=["not-json", "confidence-above-1", "empty-evidence", "unknown-action"],
)
def test_invalid_model_output_falls_back_to_deterministic_processing(
    ingestion_ai: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
    bad_reply: Any,
) -> None:
    replies = [*agents.supervisor_run()[:3], bad_reply]

    failure = _investigate(ingestion_ai, stub, replies)

    assert len(stub.state()["calls"]) == 4, "the invalid reply must actually reach the agent"
    assert stub.state()["remainingResponses"] == 0
    assert failure.get("agentInvestigation") is None
    assert "approval" not in failure
    assert failure["classification"] == "new_regression"
    assert failure["jiraKey"] is not None, "deterministic actions must still run"


def test_model_outage_falls_back_to_deterministic_processing(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    stub.script(fail={"status": 503, "times": 10})

    response = ingestion_ai.post_run(factories.run_payload([factories.result()]))

    assert response.status_code == 201
    [failure] = response.json()["failures"]
    assert len(stub.state()["calls"]) >= 1, "the agent must have tried the model"
    assert failure.get("agentInvestigation") is None
    assert failure["jiraKey"] is not None


def test_every_model_call_is_audited_with_tokens_and_latency(
    ingestion_ai: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
    db: Database,
) -> None:
    payload = factories.run_payload([factories.result()])
    stub.script(responses=agents.supervisor_run())
    [failure] = ingestion_ai.post_run(payload).json()["failures"]

    thread_id = f"{payload['runId']}:{failure['fingerprint']}"
    calls = db.rows(
        "SELECT node, model, prompt_tokens, completion_tokens, duration_ms "
        "FROM agent_model_calls WHERE thread_id = %s ORDER BY id",
        thread_id,
    )
    assert [c["node"] for c in calls] == ["triage", "repository", "action", "supervisor"]
    assert all(c["model"] == "demo-stub" and c["prompt_tokens"] > 0 for c in calls)
    timeline = (
        ingestion_ai.get(f"/api/failures/{failure['fingerprint']}/agent-executions")
        .raise_for_status()
        .json()
    )
    assert timeline["executions"][0]["thread_id"] == thread_id
