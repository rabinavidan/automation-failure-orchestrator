"""Self-test of the scriptable Ollama stub that the agent tests depend on."""

from __future__ import annotations

import json

import pytest

from support.clients import OllamaStubClient

pytestmark = pytest.mark.harness

SCHEMA = {"type": "object", "properties": {"risk": {"enum": ["low", "high"]}}}


def test_unscripted_reply_is_synthesized_from_the_requested_schema(
    stub: OllamaStubClient,
) -> None:
    reply = stub.chat(SCHEMA).raise_for_status().json()
    assert json.loads(reply["message"]["content"]) == {"risk": "low"}


def test_scripted_replies_are_returned_in_order_then_synthesis_resumes(
    stub: OllamaStubClient,
) -> None:
    stub.script(responses=[{"risk": "high"}, "not json"])

    first = stub.chat(SCHEMA).json()["message"]["content"]
    second = stub.chat(SCHEMA).json()["message"]["content"]
    third = stub.chat(SCHEMA).json()["message"]["content"]

    assert json.loads(first) == {"risk": "high"}
    assert second == "not json"
    assert json.loads(third) == {"risk": "low"}
    assert len(stub.state()["calls"]) == 3


def test_scripted_failures_return_the_status_then_recover(stub: OllamaStubClient) -> None:
    stub.script(fail={"status": 503, "times": 2})

    assert [stub.chat(SCHEMA).status_code for _ in range(3)] == [503, 503, 200]


def test_matched_scripts_only_answer_requests_that_contain_their_token(
    stub: OllamaStubClient,
) -> None:
    stub.script_for("token-A", [{"risk": "high"}])

    other = stub.http.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "about token-B"}], "format": SCHEMA},
    ).json()
    mine = stub.http.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "about token-A"}], "format": SCHEMA},
    ).json()

    assert json.loads(other["message"]["content"]) == {"risk": "low"}, "not consumed by others"
    assert json.loads(mine["message"]["content"]) == {"risk": "high"}
