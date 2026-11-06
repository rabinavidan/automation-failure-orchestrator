"""Repository knowledge (RAG) with the stub's deterministic embeddings.

The RAG instance indexes tests/backend/fixtures/rag-corpus instead of the repository, and the
stub embeds text as a hashed bag of words. Retrieval is therefore predictable: a query shares
words with exactly one topical document. This tests the platform's RAG plumbing (allowlist,
indexing, model separation, ranking, failure handling, citations), not semantic quality.
"""

from __future__ import annotations

from typing import Any

import pytest

from conftest import Database
from support import factories
from support.clients import IngestionClient, OllamaStubClient, bearer
from support.settings import Settings

pytestmark = pytest.mark.agents

INDEXED = {
    "README.md",
    "apps/ingestion-service/src/orders.ts",
    "docs/feature-flags.md",
    "docs/payments-retry.md",
    "docs/search-indexing.md",
}
NOT_INDEXED = {"scripts/deploy-notes.md", "docs/notes.txt"}
PAYMENTS_CANARY = "RAG-CANARY-PAYMENTS-4C1E"


def _reindex(client: IngestionClient, token: str | None) -> Any:
    return client.post("/api/knowledge/reindex", headers=bearer(token))


@pytest.fixture(scope="module")
def indexed(ingestion_rag: IngestionClient, settings: Settings) -> dict[str, Any]:
    """Index the fixture corpus once for this module."""
    response = _reindex(ingestion_rag, settings.admin_token)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def _search(client: IngestionClient, query: str, top_k: int = 5) -> list[dict[str, Any]]:
    response = client.post("/api/knowledge/search", json={"query": query, "topK": top_k})
    assert response.status_code == 200, response.text
    matches: list[dict[str, Any]] = response.json()["matches"]
    return matches


def test_reindexing_requires_the_admin_role(
    ingestion_rag: IngestionClient, settings: Settings
) -> None:
    assert _reindex(ingestion_rag, None).status_code == 401
    assert _reindex(ingestion_rag, settings.ci_reviewer_token).status_code == 403


def test_only_allowlisted_paths_and_extensions_are_indexed(
    indexed: dict[str, Any], db: Database
) -> None:
    rows = db.rows("SELECT DISTINCT source_path FROM repository_knowledge_chunks")
    paths = {row["source_path"] for row in rows}

    assert paths == INDEXED
    assert not paths & NOT_INDEXED
    assert indexed["fileCount"] == len(INDEXED)
    assert indexed["embeddingModel"] == "stub-embed"


def test_reindexing_twice_gives_the_same_index(
    indexed: dict[str, Any], ingestion_rag: IngestionClient, settings: Settings, db: Database
) -> None:
    again = _reindex(ingestion_rag, settings.admin_token).json()

    assert again["chunkCount"] == indexed["chunkCount"]
    total = db.one("SELECT COUNT(*) AS n FROM repository_knowledge_chunks")["n"]
    assert total == indexed["chunkCount"], "a reindex replaces the index, never appends to it"


def test_search_ranks_the_topical_document_first(
    indexed: dict[str, Any], ingestion_rag: IngestionClient
) -> None:
    matches = _search(ingestion_rag, "payment gateway timeout retry idempotency", top_k=3)

    assert len(matches) == 3
    assert matches[0]["sourcePath"] == "docs/payments-retry.md"
    scores = [m["score"] for m in matches]
    assert scores == sorted(scores, reverse=True)
    assert PAYMENTS_CANARY in matches[0]["content"]


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("search index refresh poll results", "docs/search-indexing.md"),
        ("feature flag tenant cache bypass", "docs/feature-flags.md"),
    ],
)
def test_each_topic_retrieves_its_own_document(
    indexed: dict[str, Any], ingestion_rag: IngestionClient, query: str, expected: str
) -> None:
    assert _search(ingestion_rag, query, top_k=1)[0]["sourcePath"] == expected


def test_vectors_from_another_embedding_model_are_never_compared(
    indexed: dict[str, Any], ingestion_ai: IngestionClient
) -> None:
    """An instance on the default embedding model shares the database: the index exists but is
    unusable for it, the status says so, and search returns nothing instead of meaningless
    cross-model matches (its query is still embedded, by the stub)."""
    status = ingestion_ai.get("/api/knowledge/status").json()

    assert status["chunkCount"] == indexed["chunkCount"]
    assert status["embeddingModel"] != "stub-embed"
    assert status["activeModelChunkCount"] == 0
    assert _search(ingestion_ai, "payment gateway timeout retry") == []


def test_a_failed_reindex_keeps_the_previous_index(
    indexed: dict[str, Any],
    ingestion_rag: IngestionClient,
    stub: OllamaStubClient,
    settings: Settings,
) -> None:
    stub.fail_embeddings(times=1)

    failed = _reindex(ingestion_rag, settings.admin_token)

    assert failed.status_code == 503
    status = ingestion_rag.get("/api/knowledge/status").json()
    assert status["latestRun"]["status"] == "failed"
    assert status["latestRun"]["error"]
    assert status["activeModelChunkCount"] == indexed["chunkCount"], "old index stays searchable"
    assert _search(ingestion_rag, "payment gateway timeout", top_k=1)[0]["sourcePath"] == (
        "docs/payments-retry.md"
    )


def test_investigation_cites_retrieved_sources_and_feeds_them_to_the_repository_agent(
    indexed: dict[str, Any], ingestion_rag: IngestionClient, stub: OllamaStubClient
) -> None:
    # The canary appears only in the payments document: a reply scripted for it can only be
    # consumed by the model call whose prompt contains the retrieved chunk.
    stub.reset()
    summary = "Retrieved runbook: captures are retried with an idempotency key"
    stub.script_for(
        PAYMENTS_CANARY,
        [{"summary": summary, "findings": [summary], "confidence": 0.8}],
    )
    result = factories.result(
        title="capture payment",
        error_message="Payment gateway timeout after third retry on capture",
        service="payments-service",
        endpoint="/payments/capture",
    )

    response = ingestion_rag.post_run(factories.run_payload([result]))

    assert response.status_code == 201, response.text
    [failure] = response.json()["failures"]
    investigation = failure["agentInvestigation"]
    assert "search_repository_context" in investigation["toolsUsed"]
    cited = [source["path"] for source in investigation["sources"]]
    assert cited[0] == "docs/payments-retry.md"
    repository = next(r for r in investigation["specialistReports"] if r["agent"] == "repository")
    assert repository["summary"] == summary
    assert stub.state()["scripts"][0]["remaining"] == 0
