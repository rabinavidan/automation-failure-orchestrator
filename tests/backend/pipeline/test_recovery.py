"""Recovery: a tracked failure that keeps passing is reported as possibly fixed, once."""

from __future__ import annotations

import pytest

from conftest import Database
from support import factories
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.pipeline

THRESHOLD = 3  # RECOVERY_PASS_THRESHOLD in docker-compose.yml


def _possibly_fixed(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        m
        for m in messages
        if "possibly_fixed" in str(m["payload"]).lower()
        or "possibly fixed" in str(m["payload"]).lower()
    ]


def test_consecutive_passes_after_a_tracked_failure_report_possibly_fixed_once(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    test_id = f"tests/api/orders.spec.ts::{factories.unique('fixed')}"
    [failure] = ingestion.post_run(
        factories.run_payload([factories.result(test_id=test_id)])
    ).json()["failures"]
    issue_key = failure["jiraKey"]

    for _ in range(THRESHOLD + 2):
        ingestion.post_run(factories.run_payload([factories.passed(test_id)]))

    [issue] = mock.jira_issues(label=factories.jira_label(failure["fingerprint"]))
    assert issue["key"] == issue_key
    recovery_comments = [c for c in issue["comments"] if "may be fixed" in c["body"]]
    assert len(recovery_comments) == 1, "recovery must be reported once, not on every pass"
    assert len(_possibly_fixed(mock.slack_messages())) == 1
    history = db.one(
        "SELECT consecutive_passes FROM failure_history WHERE fingerprint = %s",
        failure["fingerprint"],
    )
    assert history["consecutive_passes"] == THRESHOLD + 2


def test_a_new_failure_resets_the_recovery_count(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    test_id = f"tests/api/orders.spec.ts::{factories.unique('reset')}"
    failing = factories.result(test_id=test_id)
    [failure] = ingestion.post_run(factories.run_payload([failing])).json()["failures"]
    for _ in range(THRESHOLD - 1):
        ingestion.post_run(factories.run_payload([factories.passed(test_id)]))

    ingestion.post_run(factories.run_payload([factories.result(test_id=test_id)]))

    history = db.one(
        "SELECT consecutive_passes FROM failure_history WHERE fingerprint = %s",
        failure["fingerprint"],
    )
    assert history["consecutive_passes"] == 0
    [issue] = mock.jira_issues()
    assert not [c for c in issue["comments"] if "may be fixed" in c["body"]]


def test_history_keeps_the_last_five_outcomes(
    ingestion: IngestionClient, mock: MockIntegrationsClient, db: Database
) -> None:
    """Passes used to drop the oldest outcome unconditionally, shrinking the flaky window."""
    test_id = f"tests/api/orders.spec.ts::{factories.unique('window')}"
    [failure] = ingestion.post_run(
        factories.run_payload([factories.result(test_id=test_id)])
    ).json()["failures"]
    for _ in range(5):
        ingestion.post_run(factories.run_payload([factories.passed(test_id)]))
    ingestion.post_run(factories.run_payload([factories.result(test_id=test_id)]))

    history = db.one(
        "SELECT last_statuses FROM failure_history WHERE fingerprint = %s", failure["fingerprint"]
    )
    assert history["last_statuses"] == ["passed", "passed", "passed", "passed", "failed"]
