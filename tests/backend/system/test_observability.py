"""OpenTelemetry end to end (docker-compose.observability.yml): one run produces a trace in
Tempo (request -> run -> test, PostgreSQL, Jira and optionally GenAI spans), metrics in
Prometheus and the provisioned Grafana dashboard. EXPECT_GENAI=true when agents run."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx
import pytest

from support import factories
from support.clients import IngestionClient
from support.system import env, eventually, require_reachable

pytestmark = pytest.mark.system

TEMPO = env("TEMPO_URL", "http://localhost:3200")
PROMETHEUS = env("PROMETHEUS_URL", "http://localhost:9090")
GRAFANA = env("GRAFANA_URL", "http://localhost:3000")
EXPECT_GENAI = os.environ.get("EXPECT_GENAI") == "true"


def _attr(span: dict[str, Any], key: str) -> Any:
    for attribute in span.get("attributes", []):
        if attribute["key"] == key:
            return next(iter(attribute["value"].values()))
    return None


@pytest.fixture(scope="module")
def trace(ingestion: IngestionClient) -> dict[str, Any]:
    require_reachable(f"{TEMPO}/ready", "Tempo (Grafana LGTM)", "observability")
    test = factories.result()
    payload = factories.run_payload([test])
    assert ingestion.post_run(payload).status_code == 201
    query = f'{{ span.signalops.run_id = "{payload["runId"]}" }}'

    def find() -> str | None:
        found = httpx.get(f"{TEMPO}/api/search?q={quote(query)}&limit=1").json()["traces"]
        return found[0]["traceID"] if found else None

    trace_id = eventually("the run trace in Tempo", find)

    def complete() -> list[dict[str, Any]] | None:
        body = httpx.get(f"{TEMPO}/api/v2/traces/{trace_id}").json()
        spans = [
            s
            for rs in body["trace"]["resourceSpans"]
            for ss in rs["scopeSpans"]
            for s in ss["spans"]
        ]
        has_test = any(_attr(s, "signalops.classification") for s in spans)
        has_http = any(_attr(s, "url.full") for s in spans)
        return spans if has_test and has_http else None

    spans = eventually("the complete run trace", complete)
    return {"spans": spans, "by_id": {s["spanId"]: s for s in spans}}


def _named(trace: dict[str, Any], name: str) -> dict[str, Any]:
    [span] = [s for s in trace["spans"] if s["name"] == name][:1]
    return dict(span)


def test_run_is_one_trace_rooted_in_the_request(trace: dict[str, Any]) -> None:
    run = _named(trace, "signalops.process_run")
    test = _named(trace, "signalops.process_test")
    assert any(s["name"].startswith("POST") and not s.get("parentSpanId") for s in trace["spans"])
    assert test["parentSpanId"] == run["spanId"]
    assert _attr(test, "signalops.classification") == "new_regression"


def test_database_and_outgoing_calls_nest_under_the_test(trace: dict[str, Any]) -> None:
    test = _named(trace, "signalops.process_test")
    assert any(s["name"].startswith("pg.query") for s in trace["spans"])
    outgoing = [s for s in trace["spans"] if _attr(s, "url.full")]
    assert any("/rest/api/" in str(_attr(s, "url.full")) for s in outgoing), "Jira call traced"
    for span in outgoing:
        parent = span
        while parent.get("parentSpanId") and parent["spanId"] != test["spanId"]:
            parent = trace["by_id"][parent["parentSpanId"]]
        assert parent["spanId"] == test["spanId"]


@pytest.mark.skipif(not EXPECT_GENAI, reason="agents are off in this stack (EXPECT_GENAI)")
def test_every_model_call_is_a_genai_span_under_the_test(trace: dict[str, Any]) -> None:
    test = _named(trace, "signalops.process_test")
    chats = [s for s in trace["spans"] if _attr(s, "gen_ai.operation.name") == "chat"]
    assert chats
    for span in chats:
        assert span["parentSpanId"] == test["spanId"]
        assert _attr(span, "gen_ai.request.model")
        assert _attr(span, "signalops.agent.node")


METRICS = [
    'sum(signalops_runs_processed_total{service_name="signalops-ingestion"})',
    'sum(signalops_failures_classified_total{signalops_classification="new_regression"})',
    'sum(http_server_request_duration_seconds_count{http_route="/api/runs"})',
    "sum(db_client_operation_duration_seconds_count)",
]
if EXPECT_GENAI:
    METRICS += [
        "sum(gen_ai_client_operation_duration_seconds_count)",
        "sum(gen_ai_client_token_usage_sum)",
    ]


@pytest.mark.parametrize("query", METRICS)
def test_metrics_reach_prometheus(trace: dict[str, Any], query: str) -> None:
    def value() -> float | None:
        result = httpx.get(f"{PROMETHEUS}/api/v1/query", params={"query": query}).json()
        found = result["data"]["result"]
        number = float(found[0]["value"][1]) if found else 0.0
        return number if number > 0 else None

    assert eventually(query, value) > 0


def test_grafana_provisions_the_signalops_dashboard(trace: dict[str, Any]) -> None:
    def dashboards() -> list[str] | None:
        found = httpx.get(f"{GRAFANA}/api/search", params={"query": "SignalOps"}).json()
        titles = [d["title"] for d in found]
        return titles or None

    assert "SignalOps" in eventually("the SignalOps dashboard", dashboards)
