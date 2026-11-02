"""Thin, typed clients for each service. Tests talk to these, never to raw URLs."""

from __future__ import annotations

from typing import Any

import httpx

Json = dict[str, Any]

TIMEOUT = httpx.Timeout(30.0, connect=5.0)


class _UseConfigured:
    """Sentinel: send the configured webhook secret."""


USE_CONFIGURED = _UseConfigured()


def bearer(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


class IngestionClient:
    """The orchestrator API (apps/ingestion-service)."""

    def __init__(self, base_url: str, webhook_secret: str) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=TIMEOUT)
        self.webhook_secret = webhook_secret

    def close(self) -> None:
        self.http.close()

    def post_run(
        self, payload: Json, *, secret: str | _UseConfigured | None = USE_CONFIGURED
    ) -> httpx.Response:
        """`secret=None` omits the header; a string overrides the configured secret."""
        headers = {}
        if isinstance(secret, _UseConfigured):
            headers["x-webhook-secret"] = self.webhook_secret
        elif secret is not None:
            headers["x-webhook-secret"] = secret
        return self.http.post("/api/runs", json=payload, headers=headers)

    def get_run(self, run_id: str) -> httpx.Response:
        return self.http.get(f"/api/runs/{run_id}")

    def get_failure(self, fingerprint: str) -> httpx.Response:
        return self.http.get(f"/api/failures/{fingerprint}")

    def post_alert(
        self, payload: Json, vendor: str | None = None, *, secret: str | None = None
    ) -> httpx.Response:
        """POST /api/alerts (normalized contract) or /api/alerts/<vendor> (native SIEM payload)."""
        path = f"/api/alerts/{vendor}" if vendor else "/api/alerts"
        headers = {"x-webhook-secret": secret if secret is not None else self.webhook_secret}
        return self.http.post(path, json=payload, headers=headers)

    def get_alert(self, alert_id: str) -> Json:
        body: Json = self.http.get(f"/api/alerts/{alert_id}").raise_for_status().json()
        return dict(body["alert"])

    def response_action(self, action_id: str) -> Json:
        body: Json = self.http.get(f"/api/responses/actions/{action_id}").raise_for_status().json()
        return body

    def decide_action(
        self, action_id: str, decision: str, token: str | None, **extra: Any
    ) -> httpx.Response:
        return self.http.post(
            f"/api/responses/actions/{action_id}/decision",
            json={"decision": decision, **extra},
            headers=bearer(token),
        )

    def rollback_action(self, action_id: str, token: str | None, **body: Any) -> httpx.Response:
        return self.http.post(
            f"/api/responses/actions/{action_id}/rollback", json=body, headers=bearer(token)
        )

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return self.http.get(path, **kwargs)

    def post(self, path: str, **kwargs: Any) -> httpx.Response:
        return self.http.post(path, **kwargs)


class MockIntegrationsClient:
    """In-memory Jira, Slack, EDR and firewall (apps/mock-integrations)."""

    def __init__(self, base_url: str) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=TIMEOUT)

    def close(self) -> None:
        self.http.close()

    def reset(self) -> None:
        self.http.post("/reset").raise_for_status()

    def jira_issues(self, label: str | None = None) -> list[Json]:
        issues: list[Json] = self.http.get("/jira/issues").raise_for_status().json()["issues"]
        if label is None:
            return issues
        return [i for i in issues if label in i["fields"].get("labels", [])]

    def slack_messages(self) -> list[Json]:
        messages: list[Json] = (
            self.http.get("/slack/messages").raise_for_status().json()["messages"]
        )
        return messages

    def health(self) -> Json:
        body: Json = self.http.get("/health").raise_for_status().json()
        return body

    def firewall_blocks(self) -> dict[str, Json]:
        blocks: dict[str, Json] = (
            self.http.get("/firewall/blocks").raise_for_status().json()["blocks"]
        )
        return blocks

    def isolated_hosts(self) -> dict[str, Json]:
        hosts: dict[str, Json] = self.http.get("/edr/hosts").raise_for_status().json()["isolated"]
        return hosts

    def edr_actions(self) -> list[Json]:
        actions: list[Json] = self.http.get("/edr/actions").raise_for_status().json()["actions"]
        return actions


class OllamaStubClient:
    """Scriptable Ollama-protocol stub (scripts/ollama-demo-stub.mjs). Not a model."""

    def __init__(self, base_url: str) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=TIMEOUT)

    def close(self) -> None:
        self.http.close()

    def available(self) -> bool:
        try:
            return self.http.get("/").json().get("stub") is True
        except (httpx.HTTPError, ValueError):
            return False

    def script(self, responses: list[Json | str] | None = None, fail: Json | None = None) -> None:
        body: Json = {"responses": responses or []}
        if fail is not None:
            body["fail"] = fail
        self.http.put("/__scenario", json=body).raise_for_status()

    def state(self) -> Json:
        body: Json = self.http.get("/__scenario").raise_for_status().json()
        return body

    def reset(self) -> None:
        self.http.delete("/__scenario").raise_for_status()

    def chat(self, format_schema: Json | None = None) -> httpx.Response:
        return self.http.post(
            "/api/chat",
            json={
                "model": "test",
                "messages": [{"role": "user", "content": "hi"}],
                "format": format_schema,
            },
        )
