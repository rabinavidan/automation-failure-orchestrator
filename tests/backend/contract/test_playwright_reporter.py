"""The Playwright reporter (packages/playwright-reporter), end to end.

Runs a real Playwright project with retries on (a pass, a flaky test, a consistent failure, a
timeout, a skip and a duplicate title), then checks the reporter's output against the contract
and sends it to the API. Before this suite existed, the platform rejected its own reporter's
output and turned a flaky test into a Jira issue.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

import pytest

from support import factories
from support.clients import IngestionClient, MockIntegrationsClient
from support.contracts import errors
from support.settings import REPO_ROOT

pytestmark = pytest.mark.contract

PROJECT = Path(__file__).parents[1] / "fixtures" / "reporter-project"


@pytest.fixture(scope="module")
def report(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    npx = shutil.which("npx")
    if npx is None:
        pytest.skip("Node.js is required to run the Playwright fixture project")
    out = tmp_path_factory.mktemp("reporter")
    env = {
        **os.environ,
        "RUN_TOKEN": uuid.uuid4().hex[:8],
        "SIGNALOPS_OUTPUT_FILE": str(out / "results.json"),
        "SIGNALOPS_FIXTURE_OUTPUT_DIR": str(out / "playwright"),
        "SIGNALOPS_ENVIRONMENT": "staging",
    }
    env.pop("SIGNALOPS_INGEST_URL", None)
    completed = subprocess.run(  # noqa: S603 - fixed command, no user input
        [npx, "playwright", "test", "-c", str(PROJECT / "playwright.config.ts")],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    # Exit code 1 is expected: the fixture project contains failing tests on purpose.
    assert completed.returncode in (0, 1), completed.stdout + completed.stderr
    payload: dict[str, Any] = json.loads((out / "results.json").read_text())
    return payload


def _by_title(report: dict[str, Any], fragment: str) -> dict[str, Any]:
    [record] = [t for t in report["tests"] if fragment in t["testId"]]
    return dict(record)


def test_output_satisfies_the_webhook_contract(report: dict[str, Any]) -> None:
    assert errors("webhook-payload", report) == []


def test_one_record_per_test_with_a_consistent_summary(report: dict[str, Any]) -> None:
    assert len(report["tests"]) == 6
    assert report["summary"] == {"total": 6, "passed": 3, "failed": 2, "skipped": 1}


def test_test_ids_are_relative_stable_and_unique(report: dict[str, Any]) -> None:
    ids = [t["testId"] for t in report["tests"]]
    assert len(set(ids)) == len(ids), "identical titles in different describes must not collide"
    for test_id in ids:
        assert test_id.startswith("outcomes.spec.ts::"), test_id
        assert str(REPO_ROOT) not in test_id


def test_flaky_test_is_one_passed_record_carrying_its_first_error(
    report: dict[str, Any],
) -> None:
    flaky = _by_title(report, "flaky")
    assert (flaky["status"], flaky["retry"]) == ("passed", 1)
    assert flaky["error"]["name"] == "AssertionError"
    assert "cart badge count" in flaky["error"]["message"]


def test_consistent_failure_is_failed_after_its_retry(report: dict[str, Any]) -> None:
    failed = _by_title(report, "always-fails")
    assert (failed["status"], failed["retry"]) == ("failed", 1)
    assert failed["error"]["name"] == "AssertionError"
    assert failed["metadata"] == {
        "service": "orders-service",
        "endpoint": "/api/orders",
        "severity": "critical",
    }


def test_timeout_keeps_its_error_class(report: dict[str, Any]) -> None:
    assert _by_title(report, "times-out")["error"]["name"] == "TimeoutError"


def test_messages_carry_no_terminal_colour_codes(report: dict[str, Any]) -> None:
    assert "\u001b" not in json.dumps(report)


def test_local_artifact_paths_are_never_sent(report: dict[str, Any]) -> None:
    assert all("artifacts" not in t for t in report["tests"])


@pytest.mark.pipeline
def test_api_classifies_the_reporter_output_correctly(
    report: dict[str, Any], ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    payload = {**report, "runId": str(uuid.uuid4())}

    response = ingestion.post_run(payload)

    assert response.status_code == 201, response.text
    decisions = {f["testId"].split(">")[-1]: f for f in response.json()["failures"]}
    assert decisions["flaky:-fails-first,-passes-on-retry"]["classification"] == "flaky"
    assert decisions["always-fails-with-http-500"]["classification"] == "new_regression"
    flaky_fp = decisions["flaky:-fails-first,-passes-on-retry"]["fingerprint"]
    assert mock.jira_issues(label=factories.jira_label(flaky_fp)) == []
