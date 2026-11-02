"""Shuffle SOAR (docker-compose.shuffle.yml): the imported SOC playbook ingests a Splunk alert
through the orchestrator and posts the ChatOps message. Setup (import) stays
`npm run shuffle:setup`; this is the assertion half."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
import pytest

from support import alerts
from support.clients import MockIntegrationsClient
from support.system import env, require_reachable

pytestmark = pytest.mark.system

SHUFFLE = env("SHUFFLE_URL", "http://localhost:5001")
API_KEY = env("SHUFFLE_APIKEY", "3f6d3b8e-5c1a-4f6e-9d2b-7a1c0e4b9f21")
WORKFLOW = "SOC Alert Triage (Orchestrator)"


def _api(method: str, path: str, body: Any = None) -> Any:
    response = httpx.request(
        method,
        f"{SHUFFLE}{path}",
        json=body,
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


@pytest.fixture(scope="module")
def execution() -> dict[str, Any]:
    require_reachable(SHUFFLE, "Shuffle", "shuffle")
    workflows = _api("GET", "/api/v1/workflows")
    [workflow] = [w for w in workflows if w["name"] == WORKFLOW] or [None]
    if workflow is None:
        pytest.fail("workflow not found: run `npm run shuffle:setup` first")
    started = _api(
        "POST",
        f"/api/v1/workflows/{workflow['id']}/execute",
        {"execution_argument": json.dumps(alerts.splunk_brute_force()), "start": ""},
    )
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        result: dict[str, Any] = _api(
            "POST",
            "/api/v1/streams/results",
            {"execution_id": started["execution_id"], "authorization": started["authorization"]},
        )
        if result["status"] in {"FINISHED", "ABORTED", "FAILURE"}:
            return result
        time.sleep(3)
    pytest.fail("Shuffle execution did not finish within 300 s")


def _steps(execution: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {r["action"]["label"]: r for r in execution.get("results", [])}


def test_playbook_finishes_and_ingests_through_the_orchestrator(
    execution: dict[str, Any],
) -> None:
    assert execution["status"] == "FINISHED"
    ingest = _steps(execution)["ingest"]
    assert ingest["status"] == "SUCCESS"
    body = json.loads(ingest["result"])
    assert body["status"] == 201
    assert body["body"]["triage"]["disposition"] == "true_positive"


def test_playbook_posts_the_chatops_message(
    execution: dict[str, Any], mock_session: MockIntegrationsClient
) -> None:
    assert _steps(execution)["notify"]["status"] == "SUCCESS"
    priority = json.loads(_steps(execution)["ingest"]["result"])["body"]["triage"]["priority"]
    texts = [str(m["payload"].get("text", "")) for m in mock_session.slack_messages()]
    assert any(f"[Shuffle SOAR] {priority} true_positive" in t for t in texts)
