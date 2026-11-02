"""Read models behind the dashboard: observability summary, benchmark summary, knowledge
status, SOC metrics and response-action listings."""

from __future__ import annotations

import pytest

from support import alerts, factories
from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.api


def test_observability_summary_has_executions_calls_and_nodes(ingestion: IngestionClient) -> None:
    body = ingestion.get("/api/observability/summary").raise_for_status().json()

    assert body["window"] == "24h"
    assert {"total", "completed", "failed", "paused"} <= body["executions"].keys()
    assert {"calls", "prompt_tokens", "completion_tokens"} <= body["modelCalls"].keys()
    assert isinstance(body["byNode"], list)


def test_benchmark_summary_serves_the_committed_baseline(ingestion: IngestionClient) -> None:
    reports = ingestion.get("/api/benchmark/summary").raise_for_status().json()["reports"]

    [baseline] = [r for r in reports if r["id"] == "baseline-deterministic"]
    assert baseline["meta"]["dataset"] == "signalops-investigation-benchmark@1.1.0"
    assert baseline["meta"]["modelBackend"] == "not used"


def test_knowledge_status_reports_the_index_state(ingestion: IngestionClient) -> None:
    body = ingestion.get("/api/knowledge/status").raise_for_status().json()

    assert {"chunkCount", "sourceCount", "embeddingModel", "activeModelChunkCount"} <= body.keys()
    assert body["activeModelChunkCount"] <= body["chunkCount"]


def test_soc_metrics_count_triage_and_pending_containment(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    before = ingestion.get("/api/alerts/metrics").raise_for_status().json()
    ingestion.post_alert(alerts.splunk_brute_force(), "splunk").raise_for_status()

    after = ingestion.get("/api/alerts/metrics").raise_for_status().json()

    assert after["alerts"]["total"] == before["alerts"]["total"] + 1
    assert after["alerts"]["true_positives"] == before["alerts"]["true_positives"] + 1
    assert after["response"]["pending_approval"] >= before["response"]["pending_approval"] + 1
    assert "T1110" in {t["technique"] for t in after["topTechniques"]}
    assert 0 <= after["alerts"]["automationRate"] <= 1


def test_response_actions_can_be_filtered_by_status(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    ingestion.post_alert(alerts.splunk_brute_force(), "splunk").raise_for_status()

    body = (
        ingestion.get("/api/responses/actions", params={"status": "pending_approval"})
        .raise_for_status()
        .json()
    )

    assert body["actions"]
    assert {a["status"] for a in body["actions"]} == {"pending_approval"}


def test_response_actions_reject_an_unknown_status_filter(ingestion: IngestionClient) -> None:
    assert ingestion.get("/api/responses/actions", params={"status": "maybe"}).status_code == 400


def test_unknown_response_action_is_404(ingestion: IngestionClient) -> None:
    assert ingestion.get("/api/responses/actions/999999999").status_code == 404
    assert ingestion.get("/api/responses/actions/not-a-number").status_code == 400


def test_unknown_alert_is_404(ingestion: IngestionClient) -> None:
    assert ingestion.get("/api/alerts/no-such-alert").status_code == 404
    assert ingestion.get(f"/api/alerts/fingerprints/{'0' * 64}").status_code == 404


def test_run_detail_lists_its_results(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    payload = factories.run_payload([factories.result(), factories.passed("t::ok")])
    ingestion.post_run(payload)

    body = ingestion.get_run(payload["runId"]).raise_for_status().json()

    assert len(body["results"]) == 2
