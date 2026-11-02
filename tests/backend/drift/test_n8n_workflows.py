"""n8n workflows are a second entry point into the same pipeline. They must stay a thin front
door: same classification rules as the API, and no triage or policy logic of their own."""

from __future__ import annotations

import json
from typing import Any

import pytest

from support import alerts, factories
from support.clients import IngestionClient, MockIntegrationsClient
from support.node import run_n8n_code_node
from support.settings import REPO_ROOT

pytestmark = pytest.mark.drift

MAIN = REPO_ROOT / "n8n" / "workflows" / "main-workflow.json"
SOC = REPO_ROOT / "n8n" / "workflows" / "soc-alert-workflow.json"


def _workflow(path: Any) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text())
    return data


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


# --- main workflow: same decisions as the API ---------------------------------------------

CASES = [
    ("Error", "connect ECONNREFUSED 10.0.0.12:5432", "failed", 0),
    ("Error", "browserType.launch: Executable doesn't exist", "failed", 0),
    ("Error", "locator.click: strict mode violation: resolved to 2 elements", "failed", 0),
    ("AssertionError", "Expected 201, received 500", "failed", 0),
    ("AssertionError", "Expected 201, received 500", "failed", 2),  # failed on every retry
    ("AssertionError", "cart badge shows 0", "passed", 1),  # flaky pass
]


@pytest.mark.parametrize(("name", "message", "status", "retry"), CASES)
def test_n8n_classifies_like_the_api(
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    name: str,
    message: str,
    status: str,
    retry: int,
) -> None:
    test = factories.result(status=status, retry=retry, error_name=name, error_message=message)
    test["error"] = {"name": name, "message": message}
    [api] = ingestion.post_run(factories.run_payload([test])).json()["failures"]

    [item] = run_n8n_code_node(
        MAIN,
        "Classify Failure",
        {"input": {"issues": []}, "nodes": {"Generate Fingerprint": test}},
    )

    assert item["json"]["_classification"] == api["classification"]


def test_n8n_known_bug_follows_the_jira_lookup() -> None:
    test = factories.result()
    [item] = run_n8n_code_node(
        MAIN,
        "Classify Failure",
        {"input": {"issues": [{"key": "AUTO-1"}]}, "nodes": {"Generate Fingerprint": test}},
    )
    assert (item["json"]["_classification"], item["json"]["_jiraKey"]) == ("known_bug", "AUTO-1")


@pytest.mark.parametrize(
    ("status", "retry", "forwarded"),
    [("failed", 0, True), ("passed", 0, False), ("passed", 1, True), ("skipped", 0, False)],
)
def test_filter_forwards_failures_and_flaky_passes_only(
    status: str, retry: int, forwarded: bool
) -> None:
    test = factories.result(status=status, retry=retry)
    items = run_n8n_code_node(MAIN, "Filter Failed Tests", {"input": test})
    assert bool(items) is forwarded


# --- SOC workflow: a front door, not a second brain ---------------------------------------


def _node(workflow: dict[str, Any], name: str) -> dict[str, Any]:
    [node] = [n for n in workflow["nodes"] if n["name"] == name]
    return dict(node)


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
