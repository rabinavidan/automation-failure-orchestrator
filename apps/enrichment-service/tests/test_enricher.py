import asyncio

import httpx

from enrichment_service.cache import TTLCache
from enrichment_service.enricher import Enricher
from enrichment_service.iocs import NormalizedIndicator
from enrichment_service.models import Indicator, IndicatorType, ProviderResult
from enrichment_service.providers.mock import (
    MockAbuseIPDBProvider,
    MockGeoIPProvider,
    MockVirusTotalProvider,
)


def ind(type_: str, value: str, role: str | None = None) -> Indicator:
    return Indicator.model_validate({"type": type_, "value": value, "role": role})


def mock_enricher(timeout: float = 1.0) -> Enricher:
    return Enricher(
        [MockAbuseIPDBProvider(), MockVirusTotalProvider(), MockGeoIPProvider()],
        mode="mock",
        timeout_seconds=timeout,
        cache=TTLCache(60),
    )


async def test_brute_force_source_is_malicious() -> None:
    response = await mock_enricher().enrich([ind("ip", "203.0.113.7", "source")], alert_id="a1")
    enrichment = response.enrichments[0]
    assert enrichment.verdict == "malicious"
    assert {r.provider for r in enrichment.results} == {"abuseipdb", "virustotal", "geoip"}
    assert response.summary.verdict == "malicious"
    assert response.alert_id == "a1"


async def test_mixed_alert_summary() -> None:
    response = await mock_enricher().enrich(
        [
            ind("ip", "203.0.113.7"),
            ind("ip", "198.51.100.9"),
            ind("ip", "10.0.0.5"),
            ind("file_hash", "44d88612fea8a8f36de82e1278abb02f"),
            ind("url", "hxxp://evil[.]example[.]net/payload"),
            ind("domain", "clean.example.org"),
            ind("user", "CORP\\jdoe"),
        ]
    )
    by_value = {e.normalized_value: e for e in response.enrichments}
    assert by_value["198.51.100.9"].verdict == "suspicious"
    assert by_value["10.0.0.5"].skipped_reason is not None
    assert by_value["10.0.0.5"].results == []
    assert by_value["44d88612fea8a8f36de82e1278abb02f"].verdict == "malicious"
    assert by_value["http://evil.example.net/payload"].verdict == "malicious"
    assert by_value["clean.example.org"].verdict == "benign"
    s = response.summary
    assert (s.verdict, s.malicious, s.suspicious, s.skipped, s.enriched) == (
        "malicious",
        3,
        1,
        2,
        5,
    )


async def test_duplicate_indicators_are_enriched_once() -> None:
    response = await mock_enricher().enrich([ind("ip", "203.0.113.7"), ind("ip", "203.0.113.7 ")])
    assert len(response.enrichments) == 1


async def test_second_request_is_served_from_cache() -> None:
    enricher = mock_enricher()
    await enricher.enrich([ind("ip", "203.0.113.7")])
    again = await enricher.enrich([ind("ip", "203.0.113.7")])
    assert all(r.cached for r in again.enrichments[0].results)


class SlowProvider:
    name = "slow"
    supported_types: frozenset[IndicatorType] = frozenset({"ip"})

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        await asyncio.sleep(5)
        raise AssertionError("unreachable")


class BrokenProvider:
    name = "broken"
    supported_types: frozenset[IndicatorType] = frozenset({"ip"})

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        raise httpx.ConnectError("connect failed to https://api.example/?key=SECRET")


async def test_slow_and_broken_providers_are_isolated() -> None:
    enricher = Enricher(
        [MockAbuseIPDBProvider(), SlowProvider(), BrokenProvider()],
        mode="mock",
        timeout_seconds=0.05,
        cache=TTLCache(60),
    )
    response = await enricher.enrich([ind("ip", "203.0.113.7")])
    results = {r.provider: r for r in response.enrichments[0].results}

    assert results["abuseipdb"].verdict == "malicious"
    assert results["slow"].error is not None and "timed out" in results["slow"].error
    assert results["broken"].error == "ConnectError"
    # Exception text (which may contain secrets) is never echoed back.
    assert "SECRET" not in response.model_dump_json()
    assert response.enrichments[0].verdict == "malicious"
    assert response.summary.provider_errors == 2


async def test_informational_provider_does_not_lower_verdict() -> None:
    response = await mock_enricher().enrich([ind("ip", "8.8.8.8")])
    assert response.enrichments[0].verdict == "benign"
