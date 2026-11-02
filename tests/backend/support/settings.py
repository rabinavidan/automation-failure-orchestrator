"""Where the system under test lives. Defaults match `docker compose up` on localhost."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    ingestion_url: str
    mock_url: str
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
            mock_url=env("MOCK_URL", "http://localhost:3002"),
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
