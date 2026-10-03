from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from enrichment_service.config import Settings
from enrichment_service.main import create_app


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.delenv("WEBHOOK_SECRET", raising=False)
    with TestClient(create_app(Settings(mode="mock"))) as c:
        yield c


def test_health(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["mode"] == "mock"
    assert body["providers"] == ["abuseipdb", "virustotal", "geoip"]


def test_enrich_uses_camel_case_contract(client: TestClient) -> None:
    response = client.post(
        "/enrich",
        json={
            "alertId": "splunk:sid:abc",
            "indicators": [{"type": "ip", "value": "203.0.113.7", "role": "source"}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["alertId"] == "splunk:sid:abc"
    assert body["summary"]["verdict"] == "malicious"
    assert body["summary"]["maxScore"] == 100
    assert body["enrichments"][0]["normalizedValue"] == "203.0.113.7"


def test_enrich_validates_input(client: TestClient) -> None:
    assert client.post("/enrich", json={"indicators": [{"type": "bogus"}]}).status_code == 422
    too_many = [{"type": "ip", "value": f"8.8.8.{i}"} for i in range(101)]
    assert client.post("/enrich", json={"indicators": too_many}).status_code == 422


def test_webhook_secret_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    with TestClient(create_app(Settings(mode="mock"))) as c:
        payload = {"indicators": []}
        assert c.post("/enrich", json=payload).status_code == 401
        assert (
            c.post("/enrich", json=payload, headers={"x-webhook-secret": "no"}).status_code == 403
        )
        ok = c.post("/enrich", json=payload, headers={"x-webhook-secret": "s3cret"})
        assert ok.status_code == 200
