"""Retries: the two bugs the review proved, pinned as regression tests.

Contract: one record per test with its final outcome. `passed` with retry > 0 is flaky;
`failed` with retry > 0 failed on every attempt. Producers that still send one record per
attempt are collapsed to the same meaning.
"""

from __future__ import annotations

import pytest

from conftest import Database
from support import factories
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.pipeline


def test_pass_after_retry_is_flaky_and_opens_no_jira_issue(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    flaky = factories.result(status="passed", retry=1)
    flaky["error"] = {"name": "AssertionError", "message": "cart badge shows 0"}

    [failure] = ingestion.post_run(factories.run_payload([flaky])).json()["failures"]

    assert failure["classification"] == "flaky"
    assert mock.jira_issues() == []
    assert len(mock.slack_messages()) == 1


def test_failure_on_every_retry_is_a_regression_not_flaky(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    """Before the fix, retry > 0 alone meant flaky, so real regressions were suppressed."""
    consistent = factories.result(status="failed", retry=2)

    [failure] = ingestion.post_run(factories.run_payload([consistent])).json()["failures"]

    assert failure["classification"] == "new_regression"
    assert len(mock.jira_issues(label=factories.jira_label(failure["fingerprint"]))) == 1


def test_per_attempt_records_are_collapsed_into_one_flaky_test(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    """Before the fix, attempt 0 opened a Jira issue and attempt 1 was processed separately."""
    test_id = f"tests/ui/cart.spec.ts::{factories.unique('attempts')}"
    attempt0 = factories.result(test_id=test_id, retry=0, error_message="cart badge shows 0")
    attempt1 = factories.passed(test_id, retry=1)
    payload = factories.run_payload([attempt0, attempt1])

    body = ingestion.post_run(payload).json()

    assert body["processed"] == 1
    assert [f["classification"] for f in body["failures"]] == ["flaky"]
    assert mock.jira_issues() == []
    assert len(mock.slack_messages()) == 1
    rows = db.rows("SELECT status FROM test_results WHERE run_id = %s", payload["runId"])
    assert rows == [{"status": "passed"}]


def test_per_attempt_failures_are_one_regression_with_one_notification(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    test_id = f"tests/api/orders.spec.ts::{factories.unique('attempts')}"
    attempts = [factories.result(test_id=test_id, retry=n) for n in range(3)]

    body = ingestion.post_run(factories.run_payload(attempts)).json()

    assert body["processed"] == 1
    assert [f["classification"] for f in body["failures"]] == ["new_regression"]
    assert len(mock.jira_issues()) == 1
    assert len(mock.slack_messages()) == 1


def test_flaky_pass_does_not_count_toward_recovery(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    test_id = f"tests/ui/cart.spec.ts::{factories.unique('recovery')}"
    flaky = factories.passed(test_id, retry=1)
    flaky["error"] = {"name": "AssertionError", "message": "cart badge shows 0"}

    [failure] = ingestion.post_run(factories.run_payload([flaky])).json()["failures"]

    history = db.one(
        "SELECT consecutive_passes, fail_count FROM failure_history WHERE fingerprint = %s",
        failure["fingerprint"],
    )
    assert history == {"consecutive_passes": 0, "fail_count": 1}
