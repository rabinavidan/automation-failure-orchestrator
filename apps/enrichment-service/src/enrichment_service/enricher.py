"""Fans indicators out to providers concurrently and aggregates verdicts.

Guarantees:
* Each provider call is bounded by a timeout; a slow or failing provider
  produces an ``unknown`` result with ``error`` set and never fails the request.
* Indicators are deduplicated before lookup; results are cached per provider.
* The aggregate verdict is the most severe provider verdict (unknown < benign <
  suspicious < malicious); informational providers (verdict ``unknown``) never
  lower it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence

import httpx

from .cache import TTLCache
from .iocs import NormalizedIndicator, normalize
from .models import (
    VERDICT_RANK,
    EnrichmentSummary,
    EnrichResponse,
    Indicator,
    IndicatorEnrichment,
    ProviderResult,
    Verdict,
)
from .providers.base import Provider

logger = logging.getLogger(__name__)


class Enricher:
    def __init__(
        self,
        providers: Sequence[Provider],
        *,
        mode: str,
        timeout_seconds: float,
        cache: TTLCache[ProviderResult],
    ) -> None:
        self._providers = list(providers)
        self._mode = mode
        self._timeout = timeout_seconds
        self._cache = cache

    @property
    def provider_names(self) -> list[str]:
        return [p.name for p in self._providers]

    async def enrich(
        self, indicators: Sequence[Indicator], alert_id: str | None = None
    ) -> EnrichResponse:
        unique: dict[tuple[str, str, str | None], Indicator] = {}
        for indicator in indicators:
            key = (indicator.type, indicator.value.strip().lower(), indicator.role)
            unique.setdefault(key, indicator)

        normalized = [
            normalize(i, allow_documentation_ranges=self._mode == "mock") for i in unique.values()
        ]
        enrichments = await asyncio.gather(*(self._enrich_one(n) for n in normalized))
        return EnrichResponse(
            alert_id=alert_id,
            mode="live" if self._mode == "live" else "mock",
            summary=summarize(enrichments),
            enrichments=list(enrichments),
        )

    async def _enrich_one(self, ioc: NormalizedIndicator) -> IndicatorEnrichment:
        if not ioc.eligible:
            return IndicatorEnrichment(
                indicator=ioc.indicator,
                normalized_value=ioc.value,
                verdict="unknown",
                score=0,
                skipped_reason=ioc.skipped_reason,
            )

        providers = [p for p in self._providers if ioc.indicator.type in p.supported_types]
        results = await asyncio.gather(*(self._lookup(p, ioc) for p in providers))
        verdict, score = aggregate(results)
        return IndicatorEnrichment(
            indicator=ioc.indicator,
            normalized_value=ioc.value,
            verdict=verdict,
            score=score,
            results=list(results),
        )

    async def _lookup(self, provider: Provider, ioc: NormalizedIndicator) -> ProviderResult:
        key = f"{provider.name}:{ioc.indicator.type}:{ioc.value}"
        try:
            async with asyncio.timeout(self._timeout):
                result, cached = await self._cache.get_or_load(key, lambda: provider.lookup(ioc))
            return result.model_copy(update={"cached": cached})
        except TimeoutError:
            return _error_result(provider.name, f"timed out after {self._timeout:g}s")
        except httpx.HTTPStatusError as exc:
            return _error_result(provider.name, f"HTTP {exc.response.status_code}")
        except Exception as exc:
            # Never echo exception text: it can contain request URLs or headers.
            logger.warning("provider %s failed for %s: %s", provider.name, key, type(exc).__name__)
            return _error_result(provider.name, type(exc).__name__)


def _error_result(provider: str, error: str) -> ProviderResult:
    return ProviderResult(
        provider=provider, verdict="unknown", score=0, summary="Lookup failed", error=error
    )


def aggregate(results: Sequence[ProviderResult]) -> tuple[Verdict, int]:
    verdict: Verdict = "unknown"
    for r in results:
        if VERDICT_RANK[r.verdict] > VERDICT_RANK[verdict]:
            verdict = r.verdict
    score = max((r.score for r in results if r.error is None), default=0)
    return verdict, score


def summarize(enrichments: Sequence[IndicatorEnrichment]) -> EnrichmentSummary:
    verdict, _ = aggregate(
        [
            ProviderResult(provider="aggregate", verdict=e.verdict, score=e.score, summary="")
            for e in enrichments
        ]
    )
    return EnrichmentSummary(
        verdict=verdict,
        max_score=max((e.score for e in enrichments), default=0),
        malicious=sum(e.verdict == "malicious" for e in enrichments),
        suspicious=sum(e.verdict == "suspicious" for e in enrichments),
        enriched=sum(e.skipped_reason is None for e in enrichments),
        skipped=sum(e.skipped_reason is not None for e in enrichments),
        provider_errors=sum(r.error is not None for e in enrichments for r in e.results),
    )
