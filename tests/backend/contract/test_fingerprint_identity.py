"""Failure identity: the fingerprint the API returns, checked against the specification."""

from __future__ import annotations

import pytest

from support import factories
from support.clients import IngestionClient, MockIntegrationsClient
from support.fingerprint import fingerprint, normalize_message

pytestmark = pytest.mark.contract


@pytest.mark.parametrize(
    ("message", "normalized"),
    [
        ("order 3f2a1c9e-1b2c-4d5e-8f90-a1b2c3d4e5f6 failed", "order <UUID> failed"),
        ("at 2026-11-02T10:00:00.123Z", "at <TIMESTAMP>"),
        ("trace req-9a8b7c expired", "trace <REQ_ID> expired"),
        ("commit deadbeef12 missing", "commit <HEX_ID> missing"),
        ("wrote /tmp/run-8812/report.json", "wrote /tmp/<TEMP>/report.json"),
        ("GET http://api:8080/orders", "GET http://api:<PORT>/orders"),
        ("item 123456 not found", "item <NUM> not found"),
        ("  Expected 201, received 500  ", "Expected 201, received 500"),
    ],
)
def test_reference_normalizer_strips_dynamic_values(message: str, normalized: str) -> None:
    assert normalize_message(message) == normalized


def test_api_fingerprint_matches_the_reference_implementation(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    failing = factories.result(
        error_name="AssertionError",
        error_message="order 3f2a1c9e-1b2c-4d5e-8f90-a1b2c3d4e5f6 failed at 2026-11-02T10:00:00Z",
    )
    [failure] = ingestion.post_run(factories.run_payload([failing])).json()["failures"]

    assert failure["fingerprint"] == fingerprint(
        test_id=failing["testId"],
        service=failing["metadata"]["service"],
        error_name="AssertionError",
        error_message=failing["error"]["message"],
        endpoint=failing["metadata"]["endpoint"],
    )


def test_same_failure_with_different_dynamic_values_keeps_one_identity(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    test_id = f"tests/api/orders.spec.ts::{factories.unique('identity')}"
    first = factories.result(
        test_id=test_id, error_message="order 1a2b3c4d-0000-4000-8000-000000000001 timed out"
    )
    second = factories.result(
        test_id=test_id, error_message="order 9f8e7d6c-1111-4111-9111-111111111112 timed out"
    )

    [one] = ingestion.post_run(factories.run_payload([first])).json()["failures"]
    [two] = ingestion.post_run(factories.run_payload([second])).json()["failures"]

    assert one["fingerprint"] == two["fingerprint"]
    assert two["classification"] == "known_bug", "the second occurrence must correlate in Jira"
    assert len(mock.jira_issues()) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"metadata": {"service": "payments-service", "endpoint": "/api/orders"}},
        {"metadata": {"service": "orders-service", "endpoint": "/api/refunds"}},
        {"error": {"name": "TimeoutError", "message": "Expected 201, received 500"}},
        {"error": {"name": "AssertionError", "message": "Expected 201, received 503"}},
    ],
    ids=["service", "endpoint", "error-name", "message"],
)
def test_a_real_difference_is_a_new_identity(
    ingestion: IngestionClient, mock: MockIntegrationsClient, change: dict[str, object]
) -> None:
    base = factories.result()
    variant = {**base, **change}

    [one] = ingestion.post_run(factories.run_payload([base])).json()["failures"]
    [two] = ingestion.post_run(factories.run_payload([variant])).json()["failures"]

    assert one["fingerprint"] != two["fingerprint"]
