"""Cross-language contract: the Python enrichment service's responses must satisfy the schema
the TypeScript API parses them with (EnrichmentResponseSchema, exported to JSON Schema).
The golden example in apps/enrichment-service/contract is also asserted by the service's own
pytest suite, so a change on either side fails one of the two."""

from __future__ import annotations

import json

import httpx
import pytest

from support.contracts import errors
from support.settings import REPO_ROOT, Settings

pytestmark = pytest.mark.contract

CONTRACT = REPO_ROOT / "apps" / "enrichment-service" / "contract"


def test_golden_response_satisfies_the_typescript_schema() -> None:
    example = json.loads((CONTRACT / "enrich-response.example.json").read_text())
    assert errors("enrichment-response", example) == []


def test_live_response_for_the_golden_request_satisfies_the_schema(settings: Settings) -> None:
    request = json.loads((CONTRACT / "enrich-request.example.json").read_text())
    try:
        response = httpx.post(
            f"{settings.enrichment_url}/enrich",
            json=request,
            headers={"x-webhook-secret": settings.webhook_secret},
            timeout=30,
        )
    except httpx.HTTPError:
        pytest.skip(f"enrichment service not running at {settings.enrichment_url}")

    assert response.status_code == 200, response.text
    assert errors("enrichment-response", response.json()) == []


@pytest.mark.parametrize("field", ["mode", "summary", "enrichments"])  # alertId is optional
def test_schema_rejects_a_response_missing_a_required_field(field: str) -> None:
    example = json.loads((CONTRACT / "enrich-response.example.json").read_text())
    del example[field]
    assert errors("enrichment-response", example)
