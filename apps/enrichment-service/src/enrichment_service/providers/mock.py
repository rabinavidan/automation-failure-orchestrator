"""Deterministic offline threat intel for local development, demos and CI.

Mock providers keep the live providers' names and verdict semantics, so the
enrichment pipeline behaves identically with no API keys or network access.

Built-in intel (documentation ranges only — never real infrastructure):

* ``203.0.113.0/24``  known-bad brute-force / C2 sources   -> malicious
* ``198.51.100.0/24`` low-volume scanners                  -> suspicious
* EICAR test-file hashes                                   -> malicious
* ``*.example.net`` / hosts containing ``malicious``       -> malicious
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from ..iocs import NormalizedIndicator
from ..models import IndicatorType, ProviderResult
from .base import verdict_from_score

_BAD_NET = ipaddress.ip_network("203.0.113.0/24")
_SUSPICIOUS_NET = ipaddress.ip_network("198.51.100.0/24")

EICAR_HASHES = frozenset(
    {
        "44d88612fea8a8f36de82e1278abb02f",  # md5
        "3395856ce81f2b7382dee72602f798b642f14140",  # sha1
        "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",  # sha256
    }
)


def _ip_class(value: str) -> str:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return "clean"
    if ip.version == 4 and ip in _BAD_NET:
        return "bad"
    if ip.version == 4 and ip in _SUSPICIOUS_NET:
        return "suspicious"
    return "clean"


def _bad_domain(host: str) -> bool:
    host = host.lower()
    return host.endswith(".example.net") or host == "example.net" or "malicious" in host


class MockAbuseIPDBProvider:
    name = "abuseipdb"
    supported_types: frozenset[IndicatorType] = frozenset({"ip"})

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        cls = _ip_class(ioc.value)
        score, reports = {"bad": (100, 412), "suspicious": (40, 6), "clean": (0, 0)}[cls]
        return ProviderResult(
            provider=self.name,
            verdict=verdict_from_score(score, malicious_at=75, suspicious_at=25),
            score=score,
            summary=f"Abuse confidence {score}% from {reports} reports",
            details={"abuseConfidenceScore": score, "totalReports": reports, "mock": True},
        )


class MockVirusTotalProvider:
    name = "virustotal"
    supported_types: frozenset[IndicatorType] = frozenset({"ip", "domain", "url", "file_hash"})

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        kind = ioc.indicator.type
        if kind == "file_hash":
            malicious = 62 if ioc.value in EICAR_HASHES else 0
            suspicious = 0
        elif kind == "ip":
            malicious, suspicious = {"bad": (12, 2), "suspicious": (0, 1), "clean": (0, 0)}[
                _ip_class(ioc.value)
            ]
        else:
            host = (urlparse(ioc.value).hostname or "") if kind == "url" else ioc.value
            malicious, suspicious = (9, 1) if _bad_domain(host) else (0, 0)

        if malicious >= 3:
            verdict, score = "malicious", 90
        elif malicious or suspicious:
            verdict, score = "suspicious", 30
        else:
            verdict, score = "benign", 0
        return ProviderResult(
            provider=self.name,
            verdict=verdict,
            score=score,
            summary=f"{malicious} malicious / {suspicious} suspicious engine detections",
            details={
                "lastAnalysisStats": {
                    "malicious": malicious,
                    "suspicious": suspicious,
                    "harmless": 70 - malicious - suspicious,
                },
                "mock": True,
            },
        )


class MockGeoIPProvider:
    name = "geoip"
    supported_types: frozenset[IndicatorType] = frozenset({"ip"})

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        # "ZZ" is the user-assigned "unknown" ISO code; AS64496-64511 are documentation ASNs.
        org = {
            "bad": "AS64500 Bulletproof Hosting (mock)",
            "suspicious": "AS64501 Scanner Cloud (mock)",
            "clean": "AS64502 Example ISP (mock)",
        }[_ip_class(ioc.value)]
        return ProviderResult(
            provider=self.name,
            verdict="unknown",
            score=0,
            summary=f"ZZ, {org}",
            details={"country": "ZZ", "org": org, "mock": True},
        )
