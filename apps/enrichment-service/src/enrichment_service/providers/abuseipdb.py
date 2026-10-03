"""AbuseIPDB v2 ``/check`` — IP reputation by community abuse reports."""

from __future__ import annotations

import httpx

from ..iocs import NormalizedIndicator
from ..models import IndicatorType, ProviderResult
from .base import verdict_from_score

BASE_URL = "https://api.abuseipdb.com/api/v2"


class AbuseIPDBProvider:
    name = "abuseipdb"
    supported_types: frozenset[IndicatorType] = frozenset({"ip"})

    def __init__(self, client: httpx.AsyncClient, api_key: str) -> None:
        self._client = client
        self._api_key = api_key

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        response = await self._client.get(
            f"{BASE_URL}/check",
            params={"ipAddress": ioc.value, "maxAgeInDays": "90"},
            headers={"Key": self._api_key, "Accept": "application/json"},
        )
        response.raise_for_status()
        data = response.json().get("data", {})
        score = int(data.get("abuseConfidenceScore", 0))
        reports = int(data.get("totalReports", 0))
        return ProviderResult(
            provider=self.name,
            verdict=verdict_from_score(score, malicious_at=75, suspicious_at=25),
            score=score,
            summary=f"Abuse confidence {score}% from {reports} reports",
            details={
                "abuseConfidenceScore": score,
                "totalReports": reports,
                "countryCode": data.get("countryCode"),
                "isp": data.get("isp"),
                "usageType": data.get("usageType"),
                "isTor": data.get("isTor"),
                "lastReportedAt": data.get("lastReportedAt"),
            },
        )
