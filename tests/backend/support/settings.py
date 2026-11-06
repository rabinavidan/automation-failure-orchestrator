"""Where the system under test lives. Defaults match `docker compose up` on localhost."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    ingestion_url: str
    ingestion_ai_url: str
    ingestion_single_agent_url: str
    ingestion_rag_url: str
    mcp_scope_secret: str
    mock_url: str
    enrichment_url: str
    stub_url: str
    database_url: str
    webhook_secret: str
    ci_reviewer_token: str
    soc_responder_token: str
    admin_token: str

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ.get
        return cls(
            ingestion_url=env("INGESTION_URL", "http://localhost:3001"),
            # Second API instance with advisory agents on (scripted stub) and MCP evidence.
            ingestion_ai_url=env("INGESTION_AI_URL", "http://localhost:3011"),
            # Third instance: the single-agent tool-calling graph instead of the supervisor.
            ingestion_single_agent_url=env("INGESTION_SINGLE_AGENT_URL", "http://localhost:3012"),
            ingestion_rag_url=env("INGESTION_RAG_URL", "http://localhost:3013"),
            mcp_scope_secret=env("MCP_SCOPE_SECRET", "pytest-mcp-scope-secret-0001"),
            mock_url=env("MOCK_URL", "http://localhost:3002"),
            enrichment_url=env("ENRICHMENT_URL", "http://localhost:3003"),
            stub_url=env("OLLAMA_STUB_URL", "http://localhost:11434"),
            database_url=env(
                "TEST_DATABASE_URL",
                "postgresql://orchestrator:orchestrator@localhost:5432/orchestrator",
            ),
            webhook_secret=env("WEBHOOK_SECRET", "local-dev-secret"),
            # The demo identities from docker-compose.yml (REVIEWER_TOKENS).
            ci_reviewer_token=env("CI_REVIEWER_TOKEN", "demo-ci-reviewer-token-00001"),
            soc_responder_token=env("SOC_RESPONDER_TOKEN", "demo-soc-responder-token-0001"),
            admin_token=env("ADMIN_TOKEN", "demo-admin-token-0000000001"),
        )
