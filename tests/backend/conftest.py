"""Fixtures shared by every backend test.

The suite is black-box: it talks to running services over HTTP and reads PostgreSQL to assert
persisted state. Point it at any stack with INGESTION_URL, MOCK_URL, OLLAMA_STUB_URL and
TEST_DATABASE_URL (defaults: docker compose on localhost).
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

from support.clients import IngestionClient, MockIntegrationsClient, OllamaStubClient
from support.mcp import McpClient
from support.settings import Settings


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings.from_env()


def _wait_healthy(url: str, timeout_s: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=3.0).status_code == 200:
                return
        except httpx.HTTPError as err:
            last = err
        time.sleep(1.0)
    pytest.exit(f"System under test is not reachable at {url}: {last}", returncode=3)


@pytest.fixture(scope="session")
def ingestion(settings: Settings) -> Iterator[IngestionClient]:
    _wait_healthy(f"{settings.ingestion_url}/health")
    client = IngestionClient(settings.ingestion_url, settings.webhook_secret)
    yield client
    client.close()


@pytest.fixture(scope="session")
def ingestion_ai(settings: Settings) -> Iterator[IngestionClient]:
    """The API instance with advisory agents enabled (scripted stub) and MCP evidence."""
    try:
        healthy = httpx.get(f"{settings.ingestion_ai_url}/health", timeout=3.0).status_code == 200
    except httpx.HTTPError:
        healthy = False
    if not healthy:
        pytest.skip(f"AI-enabled API instance not running at {settings.ingestion_ai_url}")
    client = IngestionClient(settings.ingestion_ai_url, settings.webhook_secret)
    yield client
    client.close()


@pytest.fixture(scope="session")
def ingestion_single_agent(settings: Settings) -> Iterator[IngestionClient]:
    """The API instance running the single-agent tool-calling graph (failure-agent-v1)."""
    try:
        url = f"{settings.ingestion_single_agent_url}/health"
        healthy = httpx.get(url, timeout=3.0).status_code == 200
    except httpx.HTTPError:
        healthy = False
    if not healthy:
        pytest.skip(f"single-agent instance not running at {settings.ingestion_single_agent_url}")
    client = IngestionClient(settings.ingestion_single_agent_url, settings.webhook_secret)
    yield client
    client.close()


@pytest.fixture(scope="session")
def mcp(settings: Settings, ingestion_ai: IngestionClient) -> Iterator[McpClient]:
    client = McpClient(settings.ingestion_ai_url)
    yield client
    client.close()


@pytest.fixture(scope="session")
def mock_session(settings: Settings) -> Iterator[MockIntegrationsClient]:
    _wait_healthy(f"{settings.mock_url}/health")
    """Mock integrations without the per-test reset: for reading what another system wrote."""
    client = MockIntegrationsClient(settings.mock_url)
    yield client
    client.close()


@pytest.fixture
def mock(mock_session: MockIntegrationsClient) -> MockIntegrationsClient:
    """Mock Jira/Slack/EDR/firewall, emptied before the test."""
    mock_session.reset()
    return mock_session


@pytest.fixture(scope="session")
def _stub_session(settings: Settings) -> Iterator[OllamaStubClient]:
    client = OllamaStubClient(settings.stub_url)
    yield client
    client.close()


@pytest.fixture
def stub(_stub_session: OllamaStubClient) -> Iterator[OllamaStubClient]:
    """Scriptable Ollama stub; skipped when the stack runs without it. Reset after use."""
    if not _stub_session.available():
        pytest.skip("Ollama demo stub is not running (OLLAMA_STUB_URL)")
    _stub_session.reset()
    yield _stub_session
    _stub_session.reset()


class Database:
    """Read-only helpers for asserting persisted state."""

    def __init__(self, conn: psycopg.Connection[dict[str, Any]]) -> None:
        self.conn = conn

    def rows(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return list(cur.fetchall())

    def one(self, sql: str, *params: Any) -> dict[str, Any]:
        found = self.rows(sql, *params)
        assert len(found) == 1, f"expected exactly one row, got {len(found)}"
        return found[0]


@pytest.fixture(scope="session")
def db(settings: Settings) -> Iterator[Database]:
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as conn:
        yield Database(conn)
