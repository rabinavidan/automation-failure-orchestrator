"""VirusTotal v3 — multi-engine reputation for IPs, domains, URLs and file hashes."""

from __future__ import annotations

import base64
from typing import Any

import httpx

from ..iocs import NormalizedIndicator
from ..models import IndicatorType, ProviderResult, Verdict

BASE_URL = "https://www.virustotal.com/api/v3"


def resource_path(ioc: NormalizedIndicator) -> str:
    kind = ioc.indicator.type
    if kind == "ip":
        return f"/ip_addresses/{ioc.value}"
    if kind == "domain":
        return f"/domains/{ioc.value}"
    if kind == "file_hash":
        return f"/files/{ioc.value}"
    if kind == "url":
        # VT URL identifier: unpadded URL-safe base64 of the URL.
        url_id = base64.urlsafe_b64encode(ioc.value.encode()).decode().rstrip("=")
        return f"/urls/{url_id}"
    raise ValueError(f"VirusTotal does not support indicator type {kind}")


def verdict_from_stats(stats: dict[str, Any]) -> tuple[Verdict, int]:
    malicious = int(stats.get("malicious", 0))
    suspicious = int(stats.get("suspicious", 0))
    total = sum(int(v) for v in stats.values() if isinstance(v, int)) or 1
    score = min(100, round(100 * (malicious + 0.5 * suspicious) / total))
    if malicious >= 3:
        return "malicious", max(score, 75)
    if malicious >= 1 or suspicious >= 1:
        return "suspicious", max(score, 25)
    return "benign", score


class VirusTotalProvider:
    name = "virustotal"
    supported_types: frozenset[IndicatorType] = frozenset({"ip", "domain", "url", "file_hash"})

    def __init__(self, client: httpx.AsyncClient, api_key: str) -> None:
        self._client = client
        self._api_key = api_key

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        response = await self._client.get(
            f"{BASE_URL}{resource_path(ioc)}", headers={"x-apikey": self._api_key}
        )
        if response.status_code == 404:
            return ProviderResult(
                provider=self.name, verdict="unknown", score=0, summary="Not found in VirusTotal"
            )
        response.raise_for_status()
        attributes = response.json().get("data", {}).get("attributes", {})
        stats = attributes.get("last_analysis_stats", {})
        verdict, score = verdict_from_stats(stats)
        return ProviderResult(
            provider=self.name,
            verdict=verdict,
            score=score,
            summary=(
                f"{stats.get('malicious', 0)} malicious / {stats.get('suspicious', 0)} "
                f"suspicious engine detections"
            ),
            details={
                "lastAnalysisStats": stats,
                "reputation": attributes.get("reputation"),
                "tags": attributes.get("tags", []),
            },
        )
