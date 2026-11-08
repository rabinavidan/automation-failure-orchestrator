"""MCP evidence server: read-only tools, scope from a signed token rather than the model.

Tokens are minted here from the documented format (an independent implementation of the
server's HMAC scheme), so a change to the token format fails this suite.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from support import factories
from support.clients import IngestionClient, MockIntegrationsClient
from support.mcp import McpClient, mint_scope_token
from support.settings import Settings

pytestmark = pytest.mark.mcp

READ_ONLY_TOOLS = {
    "get_investigation_context",
    "get_failure_history",
    "get_related_issue",
    "search_repository_evidence",
}


@pytest.fixture
def scope(
    ingestion: IngestionClient, mock: MockIntegrationsClient, settings: Settings
) -> dict[str, Any]:
    """A real failure with history, and a token scoped to it."""
    test = factories.result()
    payload = factories.run_payload([test])
    [failure] = ingestion.post_run(payload).json()["failures"]
    token = mint_scope_token(
        secret=settings.mcp_scope_secret,
        thread_id=f"pytest:{failure['fingerprint']}",
        run_id=payload["runId"],
        fingerprint=failure["fingerprint"],
        test_id=test["testId"],
    )
    return {"token": token, "fingerprint": failure["fingerprint"], "runId": payload["runId"]}


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(result["content"][0]["text"])
    return data


def test_only_read_only_tools_are_exposed(mcp: McpClient, scope: dict[str, Any]) -> None:
    message = McpClient.result(mcp.rpc("tools/list", None, scope["token"]))
    assert {tool["name"] for tool in message["result"]["tools"]} == READ_ONLY_TOOLS


def test_in_scope_evidence_is_returned_and_marked_untrusted(
    mcp: McpClient, scope: dict[str, Any]
) -> None:
    result = mcp.call_tool(
        "get_failure_history", {"fingerprint": scope["fingerprint"]}, scope["token"]
    )

    body = _payload(result)
    assert body["untrusted"] is True
    assert body["data"]["fingerprint"] == scope["fingerprint"]
    assert body["data"]["lastStatuses"] == ["failed"]


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("get_failure_history", {"fingerprint": "a" * 64}),
        ("get_related_issue", {"fingerprint": "b" * 64}),
        ("get_investigation_context", {"runId": "another-run"}),
    ],
)
def test_requests_outside_the_token_scope_are_denied_without_data(
    mcp: McpClient, scope: dict[str, Any], tool: str, arguments: dict[str, Any]
) -> None:
    result = mcp.call_tool(tool, arguments, scope["token"])

    assert result.get("isError") is True
    assert result["content"][0]["text"].startswith("denied")


@pytest.mark.parametrize("token_kind", ["missing", "tampered", "wrong-secret", "expired"])
def test_invalid_tokens_are_rejected_before_any_tool_runs(
    mcp: McpClient, scope: dict[str, Any], settings: Settings, token_kind: str
) -> None:
    tokens: dict[str, str | None] = {
        "missing": None,
        "tampered": scope["token"][:-3] + "abc",
        "wrong-secret": mint_scope_token(
            secret="some-other-secret-0001",
            thread_id="t",
            run_id=scope["runId"],
            fingerprint=scope["fingerprint"],
            test_id="t",
        ),
        "expired": mint_scope_token(
            secret=settings.mcp_scope_secret,
            thread_id="t",
            run_id=scope["runId"],
            fingerprint=scope["fingerprint"],
            test_id="t",
            ttl=-60,
        ),
    }

    response = mcp.rpc("tools/list", None, tokens[token_kind])

    assert response.status_code == 401


def test_oversized_search_query_is_rejected(mcp: McpClient, scope: dict[str, Any]) -> None:
    message = McpClient.result(
        mcp.rpc(
            "tools/call",
            {"name": "search_repository_evidence", "arguments": {"query": "x" * 501}},
            scope["token"],
        )
    )
    rejected = "error" in message or message.get("result", {}).get("isError") is True
    assert rejected


def test_endpoint_is_disabled_without_a_scope_secret(ingestion: IngestionClient) -> None:
    """The default instance runs without MCP_SCOPE_SECRET: the endpoint refuses with 503."""
    assert ingestion.post("/mcp", json={}).status_code == 503
