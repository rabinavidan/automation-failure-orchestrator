"""SIEM front door: native Splunk, Sentinel and Wazuh payloads normalized onto one contract."""

from __future__ import annotations

from typing import Any

import pytest

from support import alerts
from support.clients import IngestionClient, MockIntegrationsClient
from support.contracts import errors

pytestmark = pytest.mark.soc


@pytest.mark.parametrize(
    ("vendor", "build", "expected_ip", "expected_technique"),
    [
        ("splunk", alerts.splunk_brute_force, alerts.MALICIOUS_IP, "T1110"),
        ("sentinel", alerts.sentinel_brute_force, "203.0.113.21", "T1110"),
        ("wazuh", alerts.wazuh_ssh_brute_force, "203.0.113.22", "T1110"),
    ],
)
def test_native_payload_is_normalized_and_stored(
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    vendor: str,
    build: Any,
    expected_ip: str,
    expected_technique: str,
) -> None:
    assert (
        errors(f"{vendor}-alert" if vendor != "splunk" else "splunk-alert-webhook", build()) == []
    )

    response = ingestion.post_alert(build(), vendor)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "new"
    stored = ingestion.get_alert(body["alertId"])
    assert stored["vendor"] == vendor
    indicator_values = {i["value"] for i in stored["indicators"]}
    assert expected_ip in indicator_values
    assert expected_technique in body["triage"]["mitre"]["techniques"]


def test_normalized_contract_is_accepted_directly(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    alert = alerts.security_alert()
    assert errors("security-alert", alert) == []

    response = ingestion.post_alert(alert)

    assert response.status_code == 201
    assert response.json()["alertId"] == alert["alertId"]


def test_unknown_vendor_is_404(ingestion: IngestionClient) -> None:
    response = ingestion.post_alert({}, "qradar")
    assert response.status_code == 404
    assert "splunk" in response.json()["error"]


@pytest.mark.parametrize("vendor", ["splunk", "sentinel", "wazuh"])
def test_malformed_vendor_payload_is_400(ingestion: IngestionClient, vendor: str) -> None:
    assert ingestion.post_alert({"unexpected": True}, vendor).status_code == 400


def test_alert_ingestion_requires_the_webhook_secret(ingestion: IngestionClient) -> None:
    response = ingestion.post_alert(alerts.splunk_brute_force(), "splunk", secret="wrong")
    assert response.status_code == 403
