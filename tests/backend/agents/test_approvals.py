"""Human-in-the-loop: a durable LangGraph interrupt holds every side effect until a
ci_reviewer decides. Approve executes the deterministic actions; reject executes none."""

from __future__ import annotations

from typing import Any

import pytest

from support import agents, factories
from support.clients import IngestionClient, MockIntegrationsClient, OllamaStubClient, bearer
from support.settings import Settings

pytestmark = pytest.mark.agents


@pytest.fixture
def pending(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> dict[str, Any]:
    """A new regression paused for review by the high-risk guardrail."""
    stub.script(responses=agents.supervisor_run(risk="high"))
    [failure] = ingestion_ai.post_run(factories.run_payload([factories.result()])).json()[
        "failures"
    ]
    assert failure["approval"]["status"] == "pending"
    return dict(failure)


def _decide(ingestion_ai: IngestionClient, thread_id: str, token: str | None, decision: Any) -> Any:
    return ingestion_ai.post(
        f"/api/approvals/{thread_id}/decision",
        json={"decision": decision, "comment": "checked the order service logs"},
        headers=bearer(token),
    )


def test_pending_request_is_listed_for_reviewers(
    ingestion_ai: IngestionClient, pending: dict[str, Any]
) -> None:
    body = ingestion_ai.get("/api/approvals", params={"status": "pending"}).json()
    [request] = [a for a in body["approvals"] if a["thread_id"] == pending["approval"]["threadId"]]
    assert request["classification"] == "new_regression"
    assert request["investigation"]["guardrailOverride"]["from"] == "create_issue"


def test_approval_executes_the_deterministic_actions(
    ingestion_ai: IngestionClient,
    pending: dict[str, Any],
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    response = _decide(
        ingestion_ai, pending["approval"]["threadId"], settings.ci_reviewer_token, "approved"
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["reviewer"]) == ("approved", "demo-ci-reviewer")
    [issue] = mock.jira_issues(label=factories.jira_label(pending["fingerprint"]))
    assert body["actions"]["jiraKey"] == issue["key"]
    assert body["actions"]["slackSent"] is True


def test_rejection_executes_nothing(
    ingestion_ai: IngestionClient,
    pending: dict[str, Any],
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    response = _decide(
        ingestion_ai, pending["approval"]["threadId"], settings.ci_reviewer_token, "rejected"
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert mock.jira_issues() == []
    assert mock.slack_messages() == []


def test_a_request_is_decided_only_once(
    ingestion_ai: IngestionClient, pending: dict[str, Any], settings: Settings
) -> None:
    thread_id = pending["approval"]["threadId"]
    _decide(ingestion_ai, thread_id, settings.ci_reviewer_token, "rejected")

    again = _decide(ingestion_ai, thread_id, settings.ci_reviewer_token, "approved")

    assert again.status_code == 409


@pytest.mark.parametrize(
    ("token_attr", "status"),
    [(None, 401), ("soc_responder_token", 403)],
    ids=["no-token", "wrong-role"],
)
def test_decisions_require_the_ci_reviewer_role(
    ingestion_ai: IngestionClient,
    pending: dict[str, Any],
    mock: MockIntegrationsClient,
    settings: Settings,
    token_attr: str | None,
    status: int,
) -> None:
    token = getattr(settings, token_attr) if token_attr else None

    response = _decide(ingestion_ai, pending["approval"]["threadId"], token, "approved")

    assert response.status_code == status
    assert mock.jira_issues() == []


def test_invalid_decision_is_400_and_unknown_thread_is_404(
    ingestion_ai: IngestionClient, pending: dict[str, Any], settings: Settings
) -> None:
    thread_id = pending["approval"]["threadId"]
    assert _decide(ingestion_ai, thread_id, settings.ci_reviewer_token, "maybe").status_code == 400
    assert (
        _decide(ingestion_ai, "no-such-thread", settings.ci_reviewer_token, "approved").status_code
        == 404
    )
