"""JSON Schema validators for the contracts exported from @orchestrator/shared-types."""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from .settings import REPO_ROOT

SCHEMA_DIR = REPO_ROOT / "contracts" / "json-schema"


@cache
def validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def errors(name: str, instance: Any) -> list[str]:
    """Human-readable violations; empty means the instance satisfies the contract."""
    return [
        f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}"
        for e in sorted(validator(name).iter_errors(instance), key=lambda e: list(e.path))
    ]
