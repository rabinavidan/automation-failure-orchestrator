"""MCP evidence server client: scope tokens minted from the documented format, JSON-RPC over
Streamable HTTP (stateless, so every request stands alone)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import httpx

Json = dict[str, Any]


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def mint_scope_token(
    *, secret: str, thread_id: str, run_id: str, fingerprint: str, test_id: str, ttl: int = 900
) -> str:
    """`base64url(JSON scope) . base64url(HMAC-SHA256(payload, secret))`, like the server."""
    scope = {
        "threadId": thread_id,
        "runId": run_id,
        "fingerprint": fingerprint,
        "testId": test_id,
        "exp": int(time.time()) + ttl,
    }
    payload = _b64url(json.dumps(scope, separators=(",", ":")).encode())
    signature = _b64url(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


class McpClient:
    def __init__(self, base_url: str) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=httpx.Timeout(30.0, connect=5.0))
        self._id = 0

    def close(self) -> None:
        self.http.close()

    def rpc(self, method: str, params: Json | None, token: str | None) -> httpx.Response:
        self._id += 1
        headers = {"Accept": "application/json, text/event-stream"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        body: Json = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}
        return self.http.post("/mcp", json=body, headers=headers)

    @staticmethod
    def result(response: httpx.Response) -> Json:
        """The JSON-RPC message, whether the server answered with JSON or one SSE event."""
        response.raise_for_status()
        if response.headers.get("content-type", "").startswith("text/event-stream"):
            data = [ln[5:].strip() for ln in response.text.splitlines() if ln.startswith("data:")]
            message: Json = json.loads(data[-1])
        else:
            message = response.json()
        return message

    def call_tool(self, name: str, arguments: Json, token: str) -> Json:
        message = self.result(self.rpc("tools/call", {"name": name, "arguments": arguments}, token))
        assert "error" not in message, message
        result: Json = message["result"]
        return result
