from __future__ import annotations

from typing import Protocol

from ..iocs import NormalizedIndicator
from ..models import IndicatorType, ProviderResult, Verdict


class Provider(Protocol):
    """A threat-intel source. Implementations must not raise for "not found";
    they return verdict ``unknown``. Transport errors may raise and are isolated
    per provider by the enricher."""

    name: str
    supported_types: frozenset[IndicatorType]

    async def lookup(self, ioc: NormalizedIndicator) -> ProviderResult: ...


def verdict_from_score(score: int, *, malicious_at: int, suspicious_at: int) -> Verdict:
    if score >= malicious_at:
        return "malicious"
    if score >= suspicious_at:
        return "suspicious"
    return "benign"
