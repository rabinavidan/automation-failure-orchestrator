"""n8n workflows are second entry points into the same pipelines. They must stay thin front
doors: they forward to the API and relay its answer, with no classification, triage or policy
logic of their own, so every decision and side effect goes through the API's policy, history,
idempotency and approval gate."""

from __future__ import annotations

import json
from typing import Any

import pytest

from support import alerts, factories
from support.clients import IngestionClient
from support.node import evaluate_n8n_expression, run_n8n_code_node
from support.settings import REPO_ROOT

pytestmark = pytest.mark.drift

MAIN = REPO_ROOT / "n8n" / "workflows" / "main-workflow.json"
SOC = REPO_ROOT / "n8n" / "workflows" / "soc-alert-workflow.json"


def _workflow(path: Any) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text())
    return data


def _node(workflow: dict[str, Any], name: str) -> dict[str, Any]:
    [node] = [n for n in workflow["nodes"] if n["name"] == name]
    return dict(node)


@pytest.mark.parametrize("path", [MAIN, SOC], ids=["main", "soc"])
def test_every_connection_targets_an_existing_node(path: Any) -> None:
    workflow = _workflow(path)
    names = [n["name"] for n in workflow["nodes"]]
    assert len(set(names)) == len(names)
    for source, outputs in workflow["connections"].items():
        assert source in names
        for branch in outputs["main"]:
            for edge in branch:
                assert edge["node"] in names


# --- main (CI) workflow: a front door that forwards to the API ----------------------------


def _http_urls(workflow: dict[str, Any]) -> list[str]:
    return [
        str(n["parameters"]["url"])
        for n in workflow["nodes"]
        if n["type"] == "n8n-nodes-base.httpRequest"
    ]


def test_ci_workflow_receives_on_its_webhook_and_only_calls_the_runs_api() -> None:
    workflow = _workflow(MAIN)
    webhook = _node(workflow, "Receive Test Results")["parameters"]
    assert (webhook["httpMethod"], webhook["path"]) == ("POST", "test-results")
    assert _http_urls(workflow) == ["http://ingestion-service:3001/api/runs"]
    ingest = _node(workflow, "Ingest via Orchestrator")["parameters"]
    assert "x-webhook-secret" in json.dumps(ingest["headerParameters"])


def test_ci_workflow_has_no_logic_of_its_own() -> None:
    """Fingerprinting, classification and every Jira or Slack action belong to the API, where
    policy, history, idempotency and the human approval gate apply."""
    workflow = _workflow(MAIN)
    assert not [n["name"] for n in workflow["nodes"] if n["type"] == "n8n-nodes-base.code"]
    for url in _http_urls(workflow):
        assert "jira" not in url.lower()
        assert "slack" not in url.lower()


@pytest.mark.parametrize("wrapped", [False, True], ids=["raw", "webhook-wrapped"])
def test_ci_workflow_forwards_the_payload_unchanged(wrapped: bool) -> None:
    payload = factories.run_payload([factories.result()])
    expression = _node(_workflow(MAIN), "Ingest via Orchestrator")["parameters"]["jsonBody"]

    body = evaluate_n8n_expression(expression, {"body": payload} if wrapped else payload)

    assert json.loads(body) == payload


def test_ci_workflow_responds_with_the_api_decisions(ingestion: IngestionClient) -> None:
    api = ingestion.post_run(factories.run_payload([factories.result()])).json()
    expression = _node(_workflow(MAIN), "Respond to CI")["parameters"]["responseBody"]

    response = json.loads(evaluate_n8n_expression(expression, api))

    [failure] = api["failures"]
    assert response == {
        "ok": True,
        "runId": api["runId"],
        "duplicate": False,
        "failures": [
            {
                "testId": failure["testId"],
                "fingerprint": failure["fingerprint"],
                "classification": failure["classification"],
                "jiraKey": failure.get("jiraKey"),
                "awaitingApproval": False,
            }
        ],
    }


# --- SOC workflow: a front door, not a second brain ---------------------------------------


def test_soc_workflow_receives_on_its_webhook_and_calls_the_vendor_endpoint() -> None:
    workflow = _workflow(SOC)
    webhook = _node(workflow, "Receive SIEM Alert")["parameters"]
    assert (webhook["httpMethod"], webhook["path"]) == ("POST", "soc-alerts")
    ingest = _node(workflow, "Ingest via Orchestrator")["parameters"]
    assert ingest["url"] == "=http://ingestion-service:3001/api/alerts/{{ $json.vendor }}"
    assert "x-webhook-secret" in json.dumps(ingest["headerParameters"])


def test_soc_switch_has_one_output_per_rule_plus_fallback() -> None:
    workflow = _workflow(SOC)
    rules = _node(workflow, "Route by Triage Disposition")["parameters"]["rules"]["values"]
    assert len(workflow["connections"]["Route by Triage Disposition"]["main"]) == len(rules) + 1


@pytest.mark.parametrize(
    ("vendor", "payload"),
    [
        ("splunk", alerts.splunk_brute_force()),
        ("sentinel", alerts.sentinel_brute_force()),
        ("wazuh", alerts.wazuh_ssh_brute_force()),
    ],
)
def test_vendor_detection_handles_raw_and_wrapped_bodies(
    vendor: str, payload: dict[str, Any]
) -> None:
    [raw] = run_n8n_code_node(SOC, "Detect SIEM Vendor", {"input": payload})
    [wrapped] = run_n8n_code_node(SOC, "Detect SIEM Vendor", {"input": {"body": payload}})
    assert raw["json"]["vendor"] == vendor
    assert wrapped["json"] == {"vendor": vendor, "payload": payload}


def test_unknown_payload_is_rejected_instead_of_guessed() -> None:
    with pytest.raises(RuntimeError, match="Unrecognized"):
        run_n8n_code_node(SOC, "Detect SIEM Vendor", {"input": {"hello": "world"}})


def test_chatops_request_lists_only_pending_containment() -> None:
    [out] = run_n8n_code_node(
        SOC,
        "Summarize Pending Containment",
        {
            "input": {
                "alertId": "splunk:x",
                "triage": {"priority": "P1", "reasons": ["Threat intel: 203.0.113.9 malicious"]},
                "response": {
                    "actions": [
                        {"id": "1", "action": "ticket.create", "status": "succeeded"},
                        {
                            "id": "3",
                            "action": "firewall.block_ip",
                            "status": "pending_approval",
                            "target": "203.0.113.9",
                        },
                    ]
                },
            }
        },
    )
    assert out["json"]["_pendingCount"] == 1
    assert "#3 *firewall.block_ip*" in out["json"]["_approvalText"]
    assert "/api/responses/actions/3/decision" in out["json"]["_approvalText"]


def test_soc_code_nodes_contain_no_triage_or_policy_logic() -> None:
    code = "\n".join(
        n["parameters"]["jsCode"]
        for n in _workflow(SOC)["nodes"]
        if n["type"] == "n8n-nodes-base.code"
    )
    for forbidden in ["allowlist", "riskScore =", "disposition =", "fingerprint"]:
        assert forbidden not in code
