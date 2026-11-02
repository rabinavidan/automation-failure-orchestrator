"""Deterministic triage: policy-as-code plus threat intel decide the disposition.

false_positive > duplicate > true_positive > benign_true_positive > needs_investigation.
"""

from __future__ import annotations

import pytest

from support import alerts
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.soc


def test_malicious_source_is_a_p1_true_positive(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    body = ingestion.post_alert(alerts.splunk_brute_force(), "splunk").json()

    assert body["enrichment"]["summary"]["verdict"] == "malicious"
    triage = body["triage"]
    assert (triage["disposition"], triage["priority"]) == ("true_positive", "P1")
    assert triage["recommendedAction"] == "escalate"
    assert any(alerts.MALICIOUS_IP in reason for reason in triage["reasons"])


def test_allowlisted_scanner_is_a_false_positive_with_no_response(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    body = ingestion.post_alert(
        alerts.splunk_brute_force(src=alerts.ALLOWLISTED_SCANNER_IP), "splunk"
    ).json()

    assert body["triage"]["disposition"] == "false_positive"
    assert "response" not in body or body["response"]["actions"] == []
    assert mock.jira_issues() == []
    assert mock.firewall_blocks() == {}


def test_known_benign_service_account_is_a_benign_true_positive(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    body = ingestion.post_alert(
        alerts.splunk_brute_force(src=alerts.SUSPICIOUS_IP, user="svc_healthcheck"), "splunk"
    ).json()

    assert body["triage"]["disposition"] == "benign_true_positive"
    assert mock.firewall_blocks() == {}


def test_suspicious_but_unproven_activity_needs_investigation(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    body = ingestion.post_alert(alerts.security_alert()).json()

    assert body["enrichment"]["summary"]["verdict"] == "suspicious"
    assert body["triage"]["disposition"] == "needs_investigation"


def test_triage_decision_is_persisted_and_filterable(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    body = ingestion.post_alert(alerts.splunk_brute_force(), "splunk").json()

    stored = ingestion.get_alert(body["alertId"])
    assert stored["triage_disposition"] == "true_positive"
    listed = ingestion.get(
        "/api/alerts", params={"disposition": "true_positive", "limit": 100}
    ).json()
    assert body["alertId"] in {a["alert_id"] for a in listed["alerts"]}


def test_invalid_filter_value_is_rejected(ingestion: IngestionClient) -> None:
    response = ingestion.get("/api/alerts", params={"disposition": "maybe"})
    assert response.status_code == 400


def test_active_triage_policy_is_exposed_with_its_version(ingestion: IngestionClient) -> None:
    body = ingestion.get("/api/alerts/triage-policy").raise_for_status().json()
    assert body["version"] == "2026.10.1"
    assert body["source"] == "config/soc-triage-policy.json"
    assert {e["id"] for e in body["allowlist"]} >= {"internal-vuln-scanner"}
