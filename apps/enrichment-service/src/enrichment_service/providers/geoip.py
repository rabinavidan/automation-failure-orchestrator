"""ipinfo.io — geolocation and ASN context. Informational only (verdict ``unknown``)."""

from __future__ import annotations

import httpx

from ..iocs import NormalizedIndicator
from ..models import IndicatorType, ProviderResult

BASE_URL = "https://ipinfo.io"


class GeoIPProvider:
    name = "geoip"
    supported_types: frozenset[IndicatorType] = frozenset({"ip"})

    def __init__(self, client: httpx.AsyncClient, token: str | None) -> None:
        self._client = client
        self._token = token

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult:
        headers = {"Accept": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        response = await self._client.get(f"{BASE_URL}/{ioc.value}/json", headers=headers)
        response.raise_for_status()
        data = response.json()
        country = data.get("country")
        org = data.get("org")
        return ProviderResult(
            provider=self.name,
            verdict="unknown",
            score=0,
            summary=f"{country or 'unknown country'}, {org or 'unknown ASN'}",
            details={
                "country": country,
                "region": data.get("region"),
                "city": data.get("city"),
                "org": org,
            },
        )
