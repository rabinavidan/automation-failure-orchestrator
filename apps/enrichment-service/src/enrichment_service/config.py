"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

Mode = Literal["mock", "live"]


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


@dataclass(frozen=True)
class Settings:
    mode: Mode = "mock"
    abuseipdb_api_key: str | None = None
    virustotal_api_key: str | None = None
    ipinfo_token: str | None = None
    provider_timeout_seconds: float = 5.0
    cache_ttl_seconds: float = 3600.0

    @classmethod
    def from_env(cls) -> Settings:
        mode: Mode = "live" if os.environ.get("ENRICHMENT_MODE", "mock") == "live" else "mock"
        return cls(
            mode=mode,
            abuseipdb_api_key=os.environ.get("ABUSEIPDB_API_KEY") or None,
            virustotal_api_key=os.environ.get("VIRUSTOTAL_API_KEY") or None,
            ipinfo_token=os.environ.get("IPINFO_TOKEN") or None,
            provider_timeout_seconds=_float("ENRICHMENT_PROVIDER_TIMEOUT_SECONDS", 5.0),
            cache_ttl_seconds=_float("ENRICHMENT_CACHE_TTL_SECONDS", 3600.0),
        )
