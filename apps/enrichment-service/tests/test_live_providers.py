import base64

import httpx
import pytest
import respx

from enrichment_service.iocs import normalize
from enrichment_service.models import Indicator
from enrichment_service.providers.abuseipdb import AbuseIPDBProvider
from enrichment_service.providers.geoip import GeoIPProvider
from enrichment_service.providers.virustotal import (
    VirusTotalProvider,
    resource_path,
    verdict_from_stats,
)


def ioc(type_: str, value: str):  # type: ignore[no-untyped-def]
    return normalize(Indicator.model_validate({"type": type_, "value": value}))


@respx.mock
async def test_abuseipdb_maps_confidence_score() -> None:
    route = respx.get("https://api.abuseipdb.com/api/v2/check").mock(
        return_value=httpx.Response(
            200,
            json={"data": {"abuseConfidenceScore": 88, "totalReports": 120, "isTor": False}},
        )
    )
    async with httpx.AsyncClient() as client:
        result = await AbuseIPDBProvider(client, "key-123").lookup(ioc("ip", "8.8.4.4"))

    assert result.verdict == "malicious"
    assert result.score == 88
    request = route.calls.last.request
    assert request.headers["Key"] == "key-123"
    assert request.url.params["ipAddress"] == "8.8.4.4"


@respx.mock
async def test_abuseipdb_raises_on_http_error() -> None:
    respx.get("https://api.abuseipdb.com/api/v2/check").mock(return_value=httpx.Response(429))
    async with httpx.AsyncClient() as client:
        with pytest.raises(httpx.HTTPStatusError):
            await AbuseIPDBProvider(client, "k").lookup(ioc("ip", "8.8.4.4"))


def test_virustotal_resource_paths() -> None:
    assert resource_path(ioc("ip", "8.8.8.8")) == "/ip_addresses/8.8.8.8"
    assert resource_path(ioc("domain", "evil.example.net")) == "/domains/evil.example.net"
    md5 = "44d88612fea8a8f36de82e1278abb02f"
    assert resource_path(ioc("file_hash", md5)) == f"/files/{md5}"
    url = "http://evil.example.net/a"
    expected = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
    assert resource_path(ioc("url", url)) == f"/urls/{expected}"


@pytest.mark.parametrize(
    ("stats", "verdict"),
    [
        ({"malicious": 10, "suspicious": 0, "harmless": 60}, "malicious"),
        ({"malicious": 1, "suspicious": 0, "harmless": 69}, "suspicious"),
        ({"malicious": 0, "suspicious": 2, "harmless": 68}, "suspicious"),
        ({"malicious": 0, "suspicious": 0, "harmless": 70}, "benign"),
    ],
)
def test_virustotal_verdict_thresholds(stats: dict[str, int], verdict: str) -> None:
    assert verdict_from_stats(stats)[0] == verdict


@respx.mock
async def test_virustotal_lookup_and_not_found() -> None:
    respx.get("https://www.virustotal.com/api/v3/files/44d88612fea8a8f36de82e1278abb02f").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "attributes": {
                        "last_analysis_stats": {"malicious": 60, "suspicious": 0, "harmless": 5},
                        "reputation": -50,
                    }
                }
            },
        )
    )
    respx.get("https://www.virustotal.com/api/v3/domains/unknown.example.org").mock(
        return_value=httpx.Response(404)
    )
    async with httpx.AsyncClient() as client:
        vt = VirusTotalProvider(client, "vt-key")
        hit = await vt.lookup(ioc("file_hash", "44d88612fea8a8f36de82e1278abb02f"))
        miss = await vt.lookup(ioc("domain", "unknown.example.org"))

    assert hit.verdict == "malicious"
    assert hit.details["reputation"] == -50
    assert miss.verdict == "unknown"
    assert miss.error is None


@respx.mock
async def test_geoip_is_informational() -> None:
    respx.get("https://ipinfo.io/8.8.8.8/json").mock(
        return_value=httpx.Response(200, json={"country": "US", "org": "AS15169 Google LLC"})
    )
    async with httpx.AsyncClient() as client:
        result = await GeoIPProvider(client, None).lookup(ioc("ip", "8.8.8.8"))
    assert result.verdict == "unknown"
    assert result.summary == "US, AS15169 Google LLC"
