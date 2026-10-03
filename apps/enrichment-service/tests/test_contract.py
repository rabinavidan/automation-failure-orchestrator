"""Golden contract test shared with the TypeScript side.

``contract/enrich-response.example.json`` is the exact mock-mode response for
``contract/enrich-request.example.json``. The ingestion service validates the same
file against its Zod ``EnrichmentResponseSchema``
(apps/ingestion-service/src/__tests__/alert-enrichment.test.ts), so a change to
either side's contract fails one of the two test suites.
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from enrichment_service.config import Settings
from enrichment_service.main import create_app

CONTRACT = Path(__file__).parent.parent / "contract"


def test_mock_response_matches_golden_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBHOOK_SECRET", raising=False)
    request = json.loads((CONTRACT / "enrich-request.example.json").read_text())
    expected = json.loads((CONTRACT / "enrich-response.example.json").read_text())

    with TestClient(create_app(Settings(mode="mock"))) as client:
        actual = client.post("/enrich", json=request).json()

    assert actual == expected
