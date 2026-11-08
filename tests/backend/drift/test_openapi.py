"""The published API (contracts/openapi.json, generated from packages/shared-types/src/api.ts)
must describe exactly the routes the ingestion service registers: hand-written API docs had
drifted by six route groups before this existed."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from openapi_spec_validator import validate

from support.settings import REPO_ROOT

pytestmark = pytest.mark.drift

SRC = REPO_ROOT / "apps" / "ingestion-service" / "src"
SPEC: dict[str, Any] = json.loads((REPO_ROOT / "contracts" / "openapi.json").read_text())


def _registered_routes() -> set[tuple[str, str]]:
    """(method, path) for every route Express registers, read from app.ts and the routers."""
    app = (SRC / "app.ts").read_text()
    mounts = dict(
        (router, prefix)
        for prefix, router in re.findall(r"app\.use\('([^']+)', (\w+?)(?:Router\b|\(\))", app)
    )
    files = {
        "health": SRC / "routes/health.ts",
        "capabilities": SRC / "routes/capabilities.ts",
        "benchmark": SRC / "routes/benchmark.ts",
        "createMcp": SRC / "routes/mcp.ts",
        "runs": SRC / "routes/runs.ts",
        "failures": SRC / "routes/failures.ts",
        "approvals": SRC / "routes/approvals.ts",
        "knowledge": SRC / "routes/knowledge.ts",
        "observability": SRC / "routes/observability.ts",
        "alerts": SRC / "routes/alerts.ts",
        "responses": SRC / "routes/responses.ts",
    }
    assert set(mounts) == set(files), f"routers mounted in app.ts changed: {sorted(mounts)}"
    routes = set()
    for router, path in files.items():
        prefix = mounts[router].rstrip("/")
        for method, sub in re.findall(r"router\.(get|post)\('([^']*)'", path.read_text()):
            full = (prefix + (sub if sub != "/" else "")) or "/"
            routes.add((method, re.sub(r":(\w+)", r"{\1}", full)))
    return routes


def _published_routes() -> set[tuple[str, str]]:
    return {(method, path) for path, ops in SPEC["paths"].items() for method in ops}


def test_the_spec_is_valid_openapi_3_1() -> None:
    assert SPEC["openapi"].startswith("3.1")
    validate(SPEC)


def test_every_registered_route_is_published_and_nothing_else() -> None:
    registered = _registered_routes()
    assert len(registered) > 25, "the route parser found too few routes"
    published = _published_routes()

    assert sorted(registered - published) == [], "routes missing from shared-types/src/api.ts"
    assert sorted(published - registered) == [], "published routes the service does not register"


def test_protected_routes_declare_their_credentials() -> None:
    for path, ops in SPEC["paths"].items():
        for method, op in ops.items():
            if method == "post" and path != "/api/knowledge/search":
                assert op["security"], f"{method.upper()} {path} declares no credentials"
            if op.get("x-required-role"):
                assert "403" in op["responses"], f"{method.upper()} {path} must document 403"
