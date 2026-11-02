"""The dashboard is served by nginx and reaches the APIs same-origin (no CORS)."""

from __future__ import annotations

import httpx
import pytest

from support.system import env, require_reachable

pytestmark = pytest.mark.system


@pytest.fixture(scope="module")
def dashboard() -> str:
    return require_reachable(
        env("DASHBOARD_URL", "http://localhost:4173"), "dashboard", "dashboard"
    )


def test_dashboard_serves_the_application(dashboard: str) -> None:
    response = httpx.get(dashboard)
    assert response.status_code == 200
    assert '<div id="root">' in response.text


def test_client_side_routes_fall_back_to_the_application(dashboard: str) -> None:
    response = httpx.get(f"{dashboard}/some/deep/link")
    assert response.status_code == 200
    assert '<div id="root">' in response.text


@pytest.mark.parametrize(
    ("path", "key"),
    [("/api/ingestion/health", "status"), ("/api/mock/health", "jiraIssues")],
)
def test_api_proxies_are_same_origin(dashboard: str, path: str, key: str) -> None:
    response = httpx.get(f"{dashboard}{path}")
    assert response.status_code == 200
    assert key in response.json()
