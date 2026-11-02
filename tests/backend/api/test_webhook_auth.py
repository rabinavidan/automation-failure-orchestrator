"""POST /api/runs is authenticated with a shared webhook secret."""

from __future__ import annotations

import pytest

from support import factories
from support.clients import IngestionClient

pytestmark = pytest.mark.api


def test_missing_secret_is_rejected_with_401(ingestion: IngestionClient) -> None:
    response = ingestion.post_run(factories.run_payload([]), secret=None)
    assert response.status_code == 401


@pytest.mark.parametrize("secret", ["wrong-secret", "local-dev-secreT", "x" * 64])
def test_wrong_secret_is_rejected_with_403(ingestion: IngestionClient, secret: str) -> None:
    response = ingestion.post_run(factories.run_payload([]), secret=secret)
    assert response.status_code == 403


def test_rejected_request_persists_nothing(ingestion: IngestionClient) -> None:
    payload = factories.run_payload([factories.result()])
    ingestion.post_run(payload, secret="wrong-secret")
    assert ingestion.get_run(payload["runId"]).status_code == 404
