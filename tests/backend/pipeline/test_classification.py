"""The deterministic decision chain and the side effects each decision is allowed to cause.

known_bug > infrastructure > automation_failure > flaky > new_regression. Only new_regression
opens a Jira issue and only known_bug comments on one; every other class notifies Slack only.
"""

from __future__ import annotations

from typing import Any

import pytest

from conftest import Database
from support import factories
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.pipeline


def _post_one(ingestion: IngestionClient, test: dict[str, Any]) -> dict[str, Any]:
    response = ingestion.post_run(factories.run_payload([test]))
    assert response.status_code == 201, response.text
    [failure] = response.json()["failures"]
    return dict(failure)


@pytest.mark.parametrize(
    ("error_name", "message", "expected"),
    [
        ("Error", "connect ECONNREFUSED 10.0.0.12:5432", "infrastructure"),
        ("Error", "getaddrinfo ENOTFOUND payments.internal", "infrastructure"),
        ("Error", "Request failed with status 503 Service Unavailable", "infrastructure"),
        ("Error", "browserType.launch: Executable doesn't exist", "infrastructure"),
        (
            "Error",
            "locator.click: strict mode violation: resolved to 2 elements",
            "automation_failure",
        ),
        ("TimeoutError", "waiting for selector '#checkout' to be visible", "automation_failure"),
        ("Error", "Cannot find module './fixtures/user'", "automation_failure"),
        ("AssertionError", "Expected 201, received 500", "new_regression"),
    ],
)
def test_error_signatures_map_to_their_class(
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    error_name: str,
    message: str,
    expected: str,
) -> None:
    failure = _post_one(ingestion, factories.result(error_name=error_name, error_message=message))

    assert failure["classification"] == expected
    issues = mock.jira_issues(label=factories.jira_label(failure["fingerprint"]))
    if expected == "new_regression":
        assert len(issues) == 1
        assert failure["jiraKey"] == issues[0]["key"]
    else:
        assert issues == [], f"{expected} must never open a Jira issue"
        assert failure.get("jiraKey") is None
    assert failure["slackSent"] is True


def test_known_bug_comments_on_the_existing_issue_instead_of_opening_one(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    test_id = f"tests/api/orders.spec.ts::{factories.unique('known')}"
    first = _post_one(ingestion, factories.result(test_id=test_id))
    second = _post_one(ingestion, factories.result(test_id=test_id))

    assert second["classification"] == "known_bug"
    assert second["jiraKey"] == first["jiraKey"]
    [issue] = mock.jira_issues()
    assert len(issue["comments"]) == 1
    assert len(mock.slack_messages()) == 2


def test_known_bug_wins_over_an_infrastructure_signature(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    """Priority order: once a fingerprint is tracked in Jira, it stays a known bug."""
    test_id = f"tests/api/orders.spec.ts::{factories.unique('priority')}"
    message = "Expected 201, received 500 after ECONNRESET"
    first = _post_one(ingestion, factories.result(test_id=test_id, error_message=message))
    assert first["classification"] == "infrastructure"
    # Track it in Jira by hand, as a triager would.
    mock.http.post(
        "/jira/rest/api/2/issue",
        json={
            "fields": {
                "summary": "tracked",
                "labels": [factories.jira_label(first["fingerprint"])],
            }
        },
    ).raise_for_status()

    second = _post_one(ingestion, factories.result(test_id=test_id, error_message=message))

    assert second["classification"] == "known_bug"


def test_history_that_keeps_flipping_is_flaky(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    """Flaky across runs: two or more pass/fail transitions in the history before this run."""
    test_id = f"tests/ui/cart.spec.ts::{factories.unique('flip')}"
    failing = factories.result(
        test_id=test_id, error_message="cart badge shows 0", service="", endpoint=""
    )
    decisions = []
    for status in ["failed", "passed", "failed", "passed", "failed"]:
        test = failing if status == "failed" else factories.passed(test_id, service="", endpoint="")
        body = ingestion.post_run(factories.run_payload([test])).json()
        decisions += [f["classification"] for f in body["failures"]]
        # Forget Jira between runs, so the history decides rather than an open issue.
        mock.reset()

    # History before each failure: [] -> [f, p] (1 transition) -> [f, p, f, p] (3 transitions)
    assert decisions == ["new_regression", "new_regression", "flaky"]


def test_every_decision_is_persisted_with_the_run(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    tests = [
        factories.result(error_message="connect ECONNREFUSED 10.0.0.12:5432"),
        factories.result(error_message="strict mode violation: 2 elements"),
        factories.result(),
        factories.passed(f"tests/api/health.spec.ts::{factories.unique('ok')}"),
    ]
    payload = factories.run_payload(tests)
    assert ingestion.post_run(payload).status_code == 201

    rows = db.rows(
        "SELECT status, classification FROM test_results WHERE run_id = %s ORDER BY status",
        payload["runId"],
    )
    assert sorted((r["status"], r["classification"]) for r in rows) == sorted(
        [
            ("failed", "infrastructure"),
            ("failed", "automation_failure"),
            ("failed", "new_regression"),
            ("passed", None),
        ]
    )
    stored = ingestion.get_run(payload["runId"]).raise_for_status().json()
    assert stored["run"]["run_id"] == payload["runId"]
