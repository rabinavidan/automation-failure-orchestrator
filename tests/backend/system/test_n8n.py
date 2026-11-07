"""Real n8n (the `n8n` system stack): both workflows are imported into n8n and driven through
their webhooks. They must behave as thin front doors: the API decides, n8n relays.

Before the CI workflow became a front door it fingerprinted, classified and called Jira and Slack
itself, then also forwarded the run, so one failing test could open two issues while skipping the
approval gate. These tests pin the fixed behaviour end to end.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from support import alerts, factories
from support.clients import IngestionClient, MockIntegrationsClient
from support.system import env, require_reachable

pytestmark = pytest.mark.system

N8N = env("N8N_URL", "http://localhost:5678")


def _webhook(path: str, body: Any) -> httpx.Response:
    require_reachable(f"{N8N}/healthz", "n8n", "n8n")
    return httpx.post(f"{N8N}/webhook/{path}", json=body, timeout=60.0)


def test_ci_results_through_n8n_get_the_api_decision_and_one_issue(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    payload = factories.run_payload([factories.result()])

    response = _webhook("test-results", payload)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runId"] == payload["runId"]
    [failure] = body["failures"]
    assert failure["classification"] == "new_regression"
    stored = ingestion.get_run(payload["runId"])
    assert stored.status_code == 200, "the run was not persisted through the API"
    issues = mock.jira_issues(label=factories.jira_label(failure["fingerprint"]))
    assert len(issues) == 1, "n8n must not open an issue of its own next to the API's"


def test_redelivery_through_n8n_is_idempotent(mock: MockIntegrationsClient) -> None:
    payload = factories.run_payload([factories.result()])

    first = _webhook("test-results", payload).json()
    again = _webhook("test-results", payload).json()

    assert first["duplicate"] is False
    assert again["duplicate"] is True


def test_soc_alert_through_n8n_is_triaged_by_the_api() -> None:
    response = _webhook("soc-alerts", alerts.splunk_brute_force(dest=alerts.host()))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["vendor"] == "splunk"
    assert body["disposition"] == "true_positive"
