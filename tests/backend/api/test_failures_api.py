"""/api/failures and /api/runs read models, and reviewer-only reclassification."""

from __future__ import annotations

import pytest

from support import factories
from support.clients import IngestionClient, MockIntegrationsClient
from support.settings import Settings

pytestmark = pytest.mark.api


@pytest.fixture
def fingerprint(ingestion: IngestionClient, mock: MockIntegrationsClient) -> str:
    [failure] = ingestion.post_run(factories.run_payload([factories.result()])).json()["failures"]
    return str(failure["fingerprint"])


def _reclassify(ingestion: IngestionClient, fp: str, token: str | None, body: object):  # type: ignore[no-untyped-def]
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return ingestion.post(f"/api/failures/{fp}/reclassify", json=body, headers=headers)


def test_reclassify_requires_a_reviewer_token(ingestion: IngestionClient, fingerprint: str) -> None:
    response = _reclassify(ingestion, fingerprint, None, {"classification": "flaky"})
    assert response.status_code == 401


def test_reclassify_requires_the_ci_reviewer_role(
    ingestion: IngestionClient, settings: Settings, fingerprint: str
) -> None:
    response = _reclassify(
        ingestion, fingerprint, settings.soc_responder_token, {"classification": "flaky"}
    )
    assert response.status_code == 403


def test_ci_reviewer_can_reclassify_and_it_is_persisted(
    ingestion: IngestionClient, settings: Settings, fingerprint: str
) -> None:
    response = _reclassify(
        ingestion, fingerprint, settings.ci_reviewer_token, {"classification": "flaky"}
    )
    assert response.status_code == 200
    body = ingestion.get_failure(fingerprint).json()
    assert body["recentResults"][0]["classification"] == "flaky"


def test_reclassify_rejects_an_unknown_class(
    ingestion: IngestionClient, settings: Settings, fingerprint: str
) -> None:
    response = _reclassify(
        ingestion, fingerprint, settings.ci_reviewer_token, {"classification": "cosmic_ray"}
    )
    assert response.status_code == 400


def test_reclassify_unknown_fingerprint_is_404(
    ingestion: IngestionClient, settings: Settings
) -> None:
    response = _reclassify(
        ingestion, "f" * 64, settings.ci_reviewer_token, {"classification": "flaky"}
    )
    assert response.status_code == 404


def test_failures_can_be_filtered_by_classification(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    ingestion.post_run(
        factories.run_payload([factories.result(error_message="connect ECONNREFUSED x")])
    )
    body = ingestion.get(
        "/api/failures", params={"classification": "infrastructure", "limit": 100}
    ).json()
    classes = {f["classification"] for f in body["failures"]}
    assert classes == {"infrastructure"}


def test_runs_are_listed_newest_first_with_paging(
    ingestion: IngestionClient, mock: MockIntegrationsClient
) -> None:
    payload = factories.run_payload([factories.passed(f"t::{factories.unique('p')}")])
    ingestion.post_run(payload)

    body = ingestion.get("/api/runs", params={"limit": 1}).json()

    assert body["limit"] == 1
    assert [r["run_id"] for r in body["runs"]] == [payload["runId"]]
    assert body["total"] >= 1
