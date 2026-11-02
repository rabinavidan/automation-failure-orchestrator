"""Reference implementation of the failure fingerprint, from its specification.

SHA-256 of `testId | service | errorName | normalizedMessage | endpoint`, lower-cased, after
replacing dynamic values in the message (packages/fingerprint-engine). The fingerprint is the
failure's identity across runs, machines and Jira, so the TypeScript engine and this
independent implementation must agree exactly. A mismatch means the identity changed.
"""

from __future__ import annotations

import hashlib
import re

# Same order and semantics as packages/fingerprint-engine/src/normalizer.ts (JS \b is ASCII).
_RULES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I | re.A),
        "<UUID>",
    ),
    (
        re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?", re.A),
        "<TIMESTAMP>",
    ),
    (re.compile(r"\b(?:req|sess|request|session)-[a-z0-9]+\b", re.I | re.A), "<REQ_ID>"),
    (re.compile(r"\b[0-9a-f]{8,}\b", re.A), "<HEX_ID>"),
    (re.compile(r"/tmp/[^\s/]+", re.A), "/tmp/<TEMP>"),  # noqa: S108 - a pattern, not a file
    (re.compile(r":(\d+)/", re.A), ":<PORT>/"),
    (re.compile(r"\b\d{4,}\b", re.A), "<NUM>"),
]


def normalize_message(message: str) -> str:
    for pattern, replacement in _RULES:
        message = pattern.sub(replacement, message)
    return message.strip()


def fingerprint(
    *, test_id: str, error_name: str, error_message: str, service: str = "", endpoint: str = ""
) -> str:
    parts = [test_id, service, error_name, normalize_message(error_message), endpoint]
    return hashlib.sha256("|".join(parts).lower().encode()).hexdigest()
