"""Deterministic evaluation gates on SOC agent output, run on every production investigation.

Replies are scripted, so each test plants one specific defect (an invented IOC, an unsupplied
runbook, advice that contradicts triage) and checks the gate catches it. The gate result is
stored on the alert (ai_evaluation) next to the investigation.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from support import agents, alerts
from support.clients import IngestionClient, MockIntegrationsClient, OllamaStubClient

pytestmark = pytest.mark.evaluation


def _investigate(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, replies: list[Any]
) -> dict[str, Any]:
    stub.script(responses=replies)
    body = ingestion_ai.post_alert(alerts.splunk_brute_force(), "splunk").json()
    assert body["triage"]["disposition"] == "true_positive"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        alert = ingestion_ai.get_alert(body["alertId"])
        if alert["ai_investigation_status"] in {"completed", "failed"}:
            assert alert["ai_investigation_status"] == "completed", alert
            return alert
        time.sleep(0.5)
    pytest.fail("SOC investigation did not finish within 30 s")


def test_grounded_investigation_passes_every_gate(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    alert = _investigate(ingestion_ai, stub, agents.soc_run())

    evaluation = alert["ai_evaluation"]
    assert evaluation["passed"] is True, evaluation["failures"]
    assert alert["ai_investigation"]["graphVersion"] == "soc-supervisor-v1"


def test_invented_indicator_fails_the_grounding_gate(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    replies = agents.soc_run(evidence=["Lateral movement to 198.51.100.99 observed"])

    evaluation = _investigate(ingestion_ai, stub, replies)["ai_evaluation"]

    assert evaluation["passed"] is False
    assert evaluation["metrics"]["iocGrounded"] is False


def test_citing_a_runbook_that_was_not_supplied_fails(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    replies = agents.soc_run(runbooks=["invented-runbook.md"])

    evaluation = _investigate(ingestion_ai, stub, replies)["ai_evaluation"]

    assert evaluation["metrics"]["runbookGrounded"] is False


def test_containment_advice_always_requires_human_approval(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    alert = _investigate(ingestion_ai, stub, agents.soc_run(recommended="contain"))

    assert alert["ai_investigation"]["requiresHumanApproval"] is True
    assert alert["ai_evaluation"]["metrics"]["safeContainmentPolicy"] is True
    assert mock.firewall_blocks() == {}, "advice never executes containment"


def test_advice_that_contradicts_triage_is_flagged_for_review(
    ingestion_ai: IngestionClient, stub: OllamaStubClient, mock: MockIntegrationsClient
) -> None:
    """Triage says escalate; the model says close. The code, not the prompt, catches it."""
    replies = agents.soc_run(recommended="close", planner_risk="low")

    investigation = _investigate(ingestion_ai, stub, replies)["ai_investigation"]

    assert investigation["conflictsWithTriage"] is True
    assert investigation["requiresHumanApproval"] is True
