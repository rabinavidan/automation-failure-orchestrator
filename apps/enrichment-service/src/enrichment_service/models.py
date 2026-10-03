"""API models. Field names are camelCase on the wire to match the TypeScript
`SecurityAlert` contract in packages/shared-types."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

IndicatorType = Literal["ip", "domain", "url", "file_hash", "email", "user", "host", "process"]
IndicatorRole = Literal["source", "destination", "target", "observed"]
Verdict = Literal["malicious", "suspicious", "benign", "unknown"]

# Ordered from least to most severe; used to aggregate provider verdicts.
VERDICT_RANK: dict[Verdict, int] = {"unknown": 0, "benign": 1, "suspicious": 2, "malicious": 3}


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Indicator(CamelModel):
    type: IndicatorType
    value: str = Field(min_length=1, max_length=2048)
    role: IndicatorRole | None = None


class EnrichRequest(CamelModel):
    alert_id: str | None = None
    indicators: list[Indicator] = Field(max_length=100)


class ProviderResult(CamelModel):
    provider: str
    verdict: Verdict
    score: int = Field(ge=0, le=100)
    summary: str
    details: dict[str, Any] = Field(default_factory=dict)
    cached: bool = False
    error: str | None = None


class IndicatorEnrichment(CamelModel):
    indicator: Indicator
    normalized_value: str
    verdict: Verdict
    score: int = Field(ge=0, le=100)
    skipped_reason: str | None = None
    results: list[ProviderResult] = Field(default_factory=list)


class EnrichmentSummary(CamelModel):
    verdict: Verdict
    max_score: int
    malicious: int
    suspicious: int
    enriched: int
    skipped: int
    provider_errors: int


class EnrichResponse(CamelModel):
    alert_id: str | None = None
    mode: Literal["mock", "live"]
    summary: EnrichmentSummary
    enrichments: list[IndicatorEnrichment]
