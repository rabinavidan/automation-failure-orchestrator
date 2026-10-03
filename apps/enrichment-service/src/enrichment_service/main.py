"""FastAPI entry point: ``POST /enrich`` and ``GET /health``."""

from __future__ import annotations

import hmac
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request

from . import __version__
from .cache import TTLCache
from .config import Settings
from .enricher import Enricher
from .models import EnrichRequest, EnrichResponse, ProviderResult
from .providers.abuseipdb import AbuseIPDBProvider
from .providers.base import Provider
from .providers.geoip import GeoIPProvider
from .providers.mock import MockAbuseIPDBProvider, MockGeoIPProvider, MockVirusTotalProvider
from .providers.virustotal import VirusTotalProvider

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("enrichment_service")


def build_providers(settings: Settings, client: httpx.AsyncClient) -> list[Provider]:
    if settings.mode == "mock":
        return [MockAbuseIPDBProvider(), MockVirusTotalProvider(), MockGeoIPProvider()]

    providers: list[Provider] = [GeoIPProvider(client, settings.ipinfo_token)]
    if settings.abuseipdb_api_key:
        providers.append(AbuseIPDBProvider(client, settings.abuseipdb_api_key))
    else:
        logger.warning("ABUSEIPDB_API_KEY not set; AbuseIPDB disabled")
    if settings.virustotal_api_key:
        providers.append(VirusTotalProvider(client, settings.virustotal_api_key))
    else:
        logger.warning("VIRUSTOTAL_API_KEY not set; VirusTotal disabled")
    return providers


def create_app(
    settings: Settings | None = None, providers: list[Provider] | None = None
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with httpx.AsyncClient(timeout=settings.provider_timeout_seconds) as client:
            app.state.enricher = Enricher(
                providers if providers is not None else build_providers(settings, client),
                mode=settings.mode,
                timeout_seconds=settings.provider_timeout_seconds,
                cache=TTLCache[ProviderResult](settings.cache_ttl_seconds),
            )
            yield

    app = FastAPI(title="Enrichment Service", version=__version__, lifespan=lifespan)

    def require_secret(
        x_webhook_secret: Annotated[str | None, Header()] = None,
    ) -> None:
        expected = os.environ.get("WEBHOOK_SECRET")
        if not expected:
            return  # dev mode, mirrors the ingestion service
        if x_webhook_secret is None:
            raise HTTPException(status_code=401, detail="Missing x-webhook-secret header")
        if not hmac.compare_digest(x_webhook_secret.encode(), expected.encode()):
            raise HTTPException(status_code=403, detail="Invalid webhook secret")

    @app.get("/health")
    async def health(request: Request) -> dict[str, object]:
        enricher: Enricher = request.app.state.enricher
        return {
            "status": "ok",
            "service": "enrichment-service",
            "version": __version__,
            "mode": settings.mode,
            "providers": enricher.provider_names,
        }

    @app.post(
        "/enrich",
        response_model=EnrichResponse,
        response_model_by_alias=True,
        dependencies=[Depends(require_secret)],
    )
    async def enrich(body: EnrichRequest, request: Request) -> EnrichResponse:
        enricher: Enricher = request.app.state.enricher
        return await enricher.enrich(body.indicators, alert_id=body.alert_id)

    return app


app = create_app()
