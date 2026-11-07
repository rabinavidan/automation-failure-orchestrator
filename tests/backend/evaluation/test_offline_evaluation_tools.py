"""Offline evaluation tooling, run as its CLIs against recorded agent executions:
`sample:failure-modes` (failure-mode taxonomy with the LLM judge) and `compare:versions`
(graph and model comparisons). Model replies come from the scripted stub, so these test the
tooling, not model quality."""

from __future__ import annotations

import os
import subprocess

import pytest

from support import agents, alerts, factories
from support.clients import IngestionClient, OllamaStubClient
from support.node import require
from support.settings import REPO_ROOT, Settings

pytestmark = pytest.mark.evaluation


@pytest.fixture(scope="module")
def recorded_executions(
    ingestion_ai: IngestionClient,
    ingestion_single_agent: IngestionClient,
    _stub_session: OllamaStubClient,
) -> None:
    """One investigation per CI graph, plus a SOC investigation in the same table."""
    _stub_session.reset()
    _stub_session.script(responses=agents.supervisor_run())
    ingestion_ai.post_run(factories.run_payload([factories.result()])).raise_for_status()
    ingestion_single_agent.post_run(factories.run_payload([factories.result()])).raise_for_status()
    _stub_session.reset()
    ingestion_ai.post_alert(alerts.splunk_brute_force(), "splunk").raise_for_status()


def _cli(settings: Settings, script: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "DATABASE_URL": settings.database_url,
        "AI_ENABLED": "true",
        "OLLAMA_HOST": settings.stub_url,
        "OLLAMA_MODEL": "demo-stub",
    }
    return subprocess.run(  # noqa: S603 - fixed command
        [require("npm"), "run", script, "--workspace=packages/evaluation", "--", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


@pytest.mark.usefixtures("recorded_executions", "mock")
def test_failure_mode_sampler_ignores_soc_investigations(settings: Settings) -> None:
    """Regression: since SOC investigations share agent_executions (migration 012), the CI
    sampler evaluated them as CI investigations and crashed on a missing field."""
    completed = _cli(settings, "sample:failure-modes", "--limit=50")

    assert completed.returncode == 0, completed.stdout[-1500:] + completed.stderr[-1500:]
    assert "Sampling up to 50 recent investigations" in completed.stdout


@pytest.mark.usefixtures("recorded_executions", "mock")
def test_graph_versions_can_be_compared(settings: Settings) -> None:
    completed = _cli(
        settings,
        "compare:versions",
        "--before-graph=failure-agent-v1",
        "--after-graph=failure-supervisor-v1",
        "--limit=20",
    )

    assert completed.returncode == 0, completed.stderr[-1500:]
    assert 'Comparing "failure-agent-v1" (before) against "failure-supervisor-v1"' in (
        completed.stdout
    )
    assert "Verdict:" in completed.stdout


@pytest.mark.usefixtures("recorded_executions", "mock")
def test_models_can_be_compared(settings: Settings) -> None:
    completed = _cli(
        settings, "compare:versions", "--before-model=demo-stub", "--after-model=demo-stub"
    )

    assert completed.returncode == 0, completed.stderr[-1500:]
    assert "Pass rate delta: +0.0%" in completed.stdout, "same model: no change"
