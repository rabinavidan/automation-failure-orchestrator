"""The ingestion service validates its whole configuration at startup (src/config.ts).

An invalid value must stop the process with a message naming the variable, never be read as a
silent default: before, `AI_ENABLED=ture` simply meant "agents off". Values that may carry
credentials are named but never echoed.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from support.node import require
from support.settings import REPO_ROOT

pytestmark = pytest.mark.api

SERVER = REPO_ROOT / "apps" / "ingestion-service" / "dist" / "server.js"


def _start(**overrides: str) -> subprocess.CompletedProcess[str]:
    if not SERVER.exists():
        pytest.skip("build the ingestion service first (npm run build)")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AI_", "OLLAMA_"))}
    env.update({"PORT": "0", "DATABASE_URL": "postgresql://invalid:invalid@127.0.0.1:1/none"})
    env.update(overrides)
    return subprocess.run(  # noqa: S603 - fixed command, repository build output only
        [require("node"), str(SERVER)],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("AI_ENABLED", "ture"),
        ("RAG_ENABLED", "1"),
        ("OLLAMA_TIMEOUT_MS", "soon"),
        ("RECOVERY_PASS_THRESHOLD", "0"),
        ("INVESTIGATION_QUEUE", "kafka"),
        ("EVIDENCE_TRANSPORT", "grpc"),
    ],
)
def test_an_invalid_value_stops_the_service_and_names_the_variable(
    variable: str, value: str
) -> None:
    result = _start(**{variable: value})

    assert result.returncode == 1
    assert f"{variable}:" in result.stderr
    assert value in result.stderr


def test_a_credential_bearing_value_is_named_but_never_echoed() -> None:
    secret = "hooks-slack-T00-secret-path-1234"
    result = _start(SLACK_WEBHOOK_URL=secret)

    assert result.returncode == 1
    assert "SLACK_WEBHOOK_URL:" in result.stderr
    assert secret not in result.stderr


def test_the_sqs_queue_requires_its_url() -> None:
    result = _start(INVESTIGATION_QUEUE="sqs")

    assert result.returncode == 1
    assert "INVESTIGATION_QUEUE_URL: is required when INVESTIGATION_QUEUE=sqs" in result.stderr
