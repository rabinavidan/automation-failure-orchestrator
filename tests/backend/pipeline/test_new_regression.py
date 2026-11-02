"""A never-seen failure, end to end: API response, PostgreSQL, Jira and Slack."""

from __future__ import annotations

import pytest

from conftest import Database
from support import factories
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.pipeline


def test_new_failure_opens_one_jira_issue_and_notifies_slack(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    failing = factories.result()
    payload = factories.run_payload([failing, factories.passed("tests/api/health.spec.ts::up")])

    response = ingestion.post_run(payload)

    assert response.status_code == 201
    body = response.json()
    assert body["processed"] == 2
    [failure] = body["failures"]
    assert failure["classification"] == "new_regression"
    assert failure["slackSent"] is True

    [issue] = mock.jira_issues(label=factories.jira_label(failure["fingerprint"]))
    assert failure["jiraKey"] == issue["key"]
    assert {"automated-test", "env-staging"} <= set(issue["fields"]["labels"])
    assert len(mock.slack_messages()) == 1

    run = db.one("SELECT summary FROM test_runs WHERE run_id = %s", payload["runId"])
    assert run["summary"]["failed"] == 1
    stored = db.one(
        "SELECT classification, jira_issue_key FROM test_results "
        "WHERE run_id = %s AND test_id = %s",
        payload["runId"],
        failing["testId"],
    )
    assert stored == {"classification": "new_regression", "jira_issue_key": issue["key"]}


def test_redelivered_run_is_idempotent(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    payload = factories.run_payload([factories.result()])
    assert ingestion.post_run(payload).status_code == 201

    again = ingestion.post_run(payload)

    assert again.status_code == 200
    assert again.json()["duplicateRun"] is True
    assert len(mock.jira_issues()) == 1, "a redelivery must not open a second issue"
    assert len(mock.slack_messages()) == 1
    rows = db.rows("SELECT 1 FROM test_results WHERE run_id = %s", payload["runId"])
    assert len(rows) == 1


def test_failure_history_is_queryable_by_fingerprint(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    payload = factories.run_payload([factories.result()])
    [failure] = ingestion.post_run(payload).json()["failures"]

    body = ingestion.get_failure(failure["fingerprint"]).raise_for_status().json()

    assert body["history"]["fingerprint"] == failure["fingerprint"]
    assert [r["classification"] for r in body["recentResults"]] == ["new_regression"]


def test_unknown_fingerprint_is_404(ingestion: IngestionClient) -> None:
    assert ingestion.get_failure("0" * 64).status_code == 404
