"""Is the stack up? Run first (`-m smoke`) so a dead dependency fails in seconds."""

from __future__ import annotations

import pytest

from support.clients import IngestionClient, MockIntegrationsClient

pytestmark = pytest.mark.smoke


def test_ingestion_service_is_healthy(ingestion: IngestionClient) -> None:
    response = ingestion.get("/health")
    assert response.status_code == 200


def test_mock_integrations_are_healthy(mock: MockIntegrationsClient) -> None:
    body = mock.health()
    assert body["status"] == "ok"
    assert body["jiraIssues"] == 0, "mock fixture must start every test empty"


def test_runtime_capabilities_describe_the_model_backend(ingestion: IngestionClient) -> None:
    body = ingestion.get("/api/capabilities").raise_for_status().json()
    assert body["model"]["backend"] in {"disabled", "stub", "real", "unreachable"}
