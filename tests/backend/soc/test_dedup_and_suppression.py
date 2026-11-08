"""Alert fatigue controls: exact redelivery is idempotent; repeats inside the window are
suppressed onto one fingerprint and do not re-run the response playbook."""

from __future__ import annotations

import pytest

from support import alerts
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.soc


def test_redelivered_alert_is_a_duplicate_delivery_with_no_new_actions(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    payload = alerts.splunk_brute_force()
    first = ingestion.post_alert(payload, "splunk")
    assert first.status_code == 201

    again = ingestion.post_alert(payload, "splunk")

    assert again.status_code == 200
    assert again.json()["status"] == "duplicate_delivery"
    assert "response" not in again.json()
    assert len(mock.jira_issues()) == 1


def test_repeat_of_the_same_activity_is_suppressed_onto_one_fingerprint(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    dest = alerts.host()
    first = ingestion.post_alert(alerts.splunk_brute_force(dest=dest), "splunk").json()

    repeat = ingestion.post_alert(alerts.splunk_brute_force(dest=dest), "splunk").json()

    assert repeat["fingerprint"] == first["fingerprint"]
    assert repeat["status"] == "suppressed"
    assert repeat["occurrenceCount"] == 2
    assert repeat["suppressedCount"] == 1
    assert "response" not in repeat, "a suppressed repeat must not open a second incident"
    assert len(mock.jira_issues()) == 1
    aggregate = ingestion.get(f"/api/alerts/fingerprints/{first['fingerprint']}").json()
    assert len(aggregate["occurrences"]) == 2


def test_one_user_in_two_spellings_is_suppressed_as_the_same_activity(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    """Identity normalization: DOMAIN\\user and user@domain are the same account."""
    dest = alerts.host()
    first = ingestion.post_alert(alerts.splunk_brute_force(dest=dest, user="CORP\\jdoe"), "splunk")
    upn = ingestion.post_alert(
        alerts.splunk_brute_force(dest=dest, user="jdoe@corp.example.com"), "splunk"
    ).json()

    assert upn["fingerprint"] == first.json()["fingerprint"]
    assert upn["status"] == "suppressed"
    assert "response" not in upn


def test_a_different_user_on_the_same_host_is_a_new_incident(ingestion: IngestionClient) -> None:
    dest = alerts.host()
    first = ingestion.post_alert(alerts.splunk_brute_force(dest=dest, user="CORP\\jdoe"), "splunk")
    other = ingestion.post_alert(
        alerts.splunk_brute_force(dest=dest, user="CORP\\asmith"), "splunk"
    ).json()

    assert other["fingerprint"] != first.json()["fingerprint"]
    assert other["status"] == "new"


def test_different_target_is_a_different_incident(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    one = ingestion.post_alert(alerts.splunk_brute_force(), "splunk").json()
    two = ingestion.post_alert(alerts.splunk_brute_force(), "splunk").json()

    assert one["fingerprint"] != two["fingerprint"]
    assert two["status"] == "new"
