"""Response playbooks: tickets and notifications run immediately; containment (firewall,
EDR) is planned as pending_approval and only executes after a soc_responder decision."""

from __future__ import annotations

from typing import Any

import pytest

from support import alerts
from support.clients import IngestionClient, MockIntegrationsClient
from support.settings import Settings

pytestmark = pytest.mark.soc


def _actions(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {a["stepId"]: a for a in body["response"]["actions"]}


@pytest.fixture
def brute_force(ingestion: IngestionClient, mock: MockIntegrationsClient) -> dict[str, Any]:
    """A confirmed brute force: the playbook opened a ticket and planned an IP block."""
    body = ingestion.post_alert(alerts.splunk_brute_force(), "splunk").json()
    assert body["response"]["playbooks"] == ["brute-force-response"]
    return dict(body)


def test_ticket_and_notification_run_but_containment_waits(
    brute_force: dict[str, Any], mock: MockIntegrationsClient
) -> None:
    steps = _actions(brute_force)

    assert steps["open-case"]["status"] == "succeeded"
    assert steps["notify-soc"]["status"] == "succeeded"
    block = steps["block-source-ip"]
    assert (block["status"], block["target"]) == ("pending_approval", alerts.MALICIOUS_IP)
    assert len(mock.jira_issues()) == 1
    assert mock.firewall_blocks() == {}, "no containment before a human decision"


def test_approved_block_executes_and_records_the_authenticated_reviewer(
    brute_force: dict[str, Any],
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    block = _actions(brute_force)["block-source-ip"]

    response = ingestion.decide_action(
        block["id"],
        "approved",
        settings.soc_responder_token,
        reviewer="someone-else",  # the body cannot override the token's identity
        comment="confirmed with the account owner",
    )

    assert response.status_code == 200
    assert response.json()["status"] == "succeeded"
    assert alerts.MALICIOUS_IP in mock.firewall_blocks()
    stored = ingestion.response_action(block["id"])
    assert stored["action"]["reviewer"] == "demo-soc-responder"
    assert [e["event"] for e in stored["events"]][:3] == ["planned", "approved", "executed"]


def test_rejected_block_never_executes(
    brute_force: dict[str, Any],
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    block = _actions(brute_force)["block-source-ip"]

    response = ingestion.decide_action(block["id"], "rejected", settings.soc_responder_token)

    assert response.status_code == 200
    assert mock.firewall_blocks() == {}
    assert ingestion.response_action(block["id"])["action"]["status"] == "rejected"


def test_an_action_is_decided_only_once(
    brute_force: dict[str, Any], ingestion: IngestionClient, settings: Settings
) -> None:
    block = _actions(brute_force)["block-source-ip"]
    ingestion.decide_action(block["id"], "rejected", settings.soc_responder_token)

    again = ingestion.decide_action(block["id"], "approved", settings.soc_responder_token)

    assert again.status_code == 409


def test_executed_block_can_be_rolled_back(
    brute_force: dict[str, Any],
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    block = _actions(brute_force)["block-source-ip"]
    ingestion.decide_action(block["id"], "approved", settings.soc_responder_token)

    response = ingestion.rollback_action(
        block["id"], settings.soc_responder_token, reason="false alarm"
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rolled_back"
    assert mock.firewall_blocks() == {}


@pytest.mark.parametrize(
    ("token_attr", "status"),
    [(None, 401), ("ci_reviewer_token", 403)],
    ids=["no-token", "wrong-role"],
)
def test_containment_decisions_require_the_soc_responder_role(
    brute_force: dict[str, Any],
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    settings: Settings,
    token_attr: str | None,
    status: int,
) -> None:
    token = getattr(settings, token_attr) if token_attr else None
    block = _actions(brute_force)["block-source-ip"]

    response = ingestion.decide_action(block["id"], "approved", token)

    assert response.status_code == status
    assert mock.firewall_blocks() == {}


def test_malware_plans_process_kill_host_isolation_and_c2_block(
    ingestion: IngestionClient, mock: MockIntegrationsClient, settings: Settings
) -> None:
    dest_host = alerts.host().split(".")[0]
    body = ingestion.post_alert(alerts.splunk_malware(dest_host=dest_host), "splunk").json()
    steps = _actions(body)

    planned = {k: v["status"] for k, v in steps.items() if k not in {"open-case", "notify-soc"}}
    assert set(planned.values()) == {"pending_approval"}
    assert {"kill-process", "isolate-host"} <= planned.keys()

    isolate = steps["isolate-host"]
    ingestion.decide_action(isolate["id"], "approved", settings.soc_responder_token)
    assert dest_host.lower() in {h.lower() for h in mock.isolated_hosts()}


def test_protected_host_isolation_is_blocked_by_guard_and_cannot_be_approved(
    ingestion: IngestionClient, mock: MockIntegrationsClient, settings: Settings
) -> None:
    """dc-01 is in SOC_PROTECTED_HOSTS: the guard refuses at planning time, and approval
    cannot override it. The rest of the playbook still proceeds."""
    body = ingestion.post_alert(alerts.splunk_malware(dest_host="dc-01"), "splunk").json()
    steps = _actions(body)

    isolate = steps["isolate-host"]
    assert isolate["status"] == "blocked_by_guard"
    assert "protected" in isolate["detail"]
    assert steps["kill-process"]["status"] == "pending_approval"

    response = ingestion.decide_action(isolate["id"], "approved", settings.soc_responder_token)

    assert response.status_code == 409
    assert mock.isolated_hosts() == {}


def test_needs_investigation_opens_an_analyst_case_without_containment(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    body = ingestion.post_alert(alerts.security_alert(severity="high")).json()

    assert (body["triage"]["disposition"], body["triage"]["priority"]) == (
        "needs_investigation",
        "P2",
    )
    assert body["response"]["playbooks"] == ["analyst-queue"]
    actions = body["response"]["actions"]
    assert sorted(a["action"] for a in actions) == ["slack.notify", "ticket.create"]
    assert {a["status"] for a in actions} == {"succeeded"}
    assert len(mock.jira_issues()) == 1
    assert mock.firewall_blocks() == {}
    assert mock.isolated_hosts() == {}


def test_concurrent_approvals_produce_exactly_one_transition_and_one_execution(
    brute_force: dict[str, Any],
    ingestion: IngestionClient,
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    """Postgres serializes the conditional update: one approval wins, the others get 409."""
    from concurrent.futures import ThreadPoolExecutor

    block = _actions(brute_force)["block-source-ip"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(
            pool.map(
                lambda _: ingestion.decide_action(
                    block["id"], "approved", settings.soc_responder_token
                ),
                range(4),
            )
        )

    assert sorted(r.status_code for r in responses) == [200, 409, 409, 409]
    stored = ingestion.response_action(block["id"])
    assert [e["event"] for e in stored["events"]].count("executed") == 1
    assert list(mock.firewall_blocks()) == [alerts.MALICIOUS_IP]
