"""The CI action policy has one source (failure-actions.ts): a failure handled directly and the
same kind of failure executed after a human approval must produce the same side effects.

Before, the policy was written twice in run-processor.ts (the processing switch and the
post-approval executor); a change to one would have made approved runs behave differently.
"""

from __future__ import annotations

from typing import Any

import pytest

from support import agents, factories
from support.clients import IngestionClient, MockIntegrationsClient, OllamaStubClient, bearer
from support.fingerprint import fingerprint
from support.settings import Settings

pytestmark = pytest.mark.agents

CASES = {
    "new_regression": ("AssertionError", "Expected 201, received 500", False),
    "known_bug": ("AssertionError", "Expected 201, received 500", True),
    "infrastructure": ("Error", "connect ECONNREFUSED 10.0.0.12:5432", False),
    "automation_failure": (
        "Error",
        "locator.click: strict mode violation: resolved to 2 elements",
        False,
    ),
}


def _failure(mock: MockIntegrationsClient, case: str) -> tuple[dict[str, Any], str]:
    """A failing test of the given class; for a known bug, its tracked Jira issue is seeded."""
    error_name, message, tracked = CASES[case]
    test = factories.result(error_name=error_name, error_message=message)
    label = factories.jira_label(
        fingerprint(
            test_id=test["testId"],
            error_name=error_name,
            error_message=message,
            service=test["metadata"]["service"],
            endpoint=test["metadata"]["endpoint"],
        )
    )
    if tracked:
        mock.http.post(
            "/jira/rest/api/2/issue",
            json={"fields": {"summary": "Tracked bug", "labels": [label]}},
        ).raise_for_status()
    return test, label


def _effects(mock: MockIntegrationsClient, label: str) -> dict[str, Any]:
    issues = mock.jira_issues(label=label)
    return {
        "issues": len(issues),
        "comments": sum(len(issue.get("comments", [])) for issue in issues),
        "slack": len(mock.slack_messages()),
    }


@pytest.mark.parametrize("case", sorted(CASES))
def test_approved_failures_get_the_same_actions_as_direct_ones(
    case: str,
    ingestion: IngestionClient,
    ingestion_ai: IngestionClient,
    stub: OllamaStubClient,
    mock: MockIntegrationsClient,
    settings: Settings,
) -> None:
    test, label = _failure(mock, case)
    [direct] = ingestion.post_run(factories.run_payload([test])).json()["failures"]
    assert direct["classification"] == case
    direct_effects = _effects(mock, label)

    mock.reset()
    test, label = _failure(mock, case)
    stub.script(responses=agents.supervisor_run(risk="high"))
    [paused] = ingestion_ai.post_run(factories.run_payload([test])).json()["failures"]
    assert paused["classification"] == case
    assert _effects(mock, label)["slack"] == 0, "nothing may run before the decision"
    decision = ingestion_ai.post(
        f"/api/approvals/{paused['approval']['threadId']}/decision",
        json={"decision": "approved", "comment": "parity check"},
        headers=bearer(settings.ci_reviewer_token),
    )
    assert decision.status_code == 200, decision.text

    assert _effects(mock, label) == direct_effects
