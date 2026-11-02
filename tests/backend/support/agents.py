"""Scripted replies for the multi-agent supervisor graph (failure-supervisor-v1).

The graph calls the model four times, in order: triage, repository, action, supervisor.
Scripting those replies makes agent behaviour deterministic, so tests can target the code
around the model: guardrails, schema validation, fail-safe fallbacks and the approval gate.
"""

from __future__ import annotations

from typing import Any

Json = dict[str, Any]


def specialist(summary: str, confidence: float = 0.7) -> Json:
    return {"summary": summary, "findings": [summary], "confidence": confidence}


def supervisor_run(
    *,
    proposed: str = "create_issue",
    risk: str = "low",
    recommended: str = "create_issue",
    confidence: float = 0.8,
) -> list[Json | str]:
    return [
        specialist("triage: deterministic class and history agree"),
        specialist("repository: no related change found"),
        {**specialist("action: policy assessment"), "proposedAction": proposed, "risk": risk},
        {
            "suspectedRootCause": "POST /api/orders returns 500",
            "evidence": ["Expected 201, received 500"],
            "recommendedAction": recommended,
            "confidence": confidence,
            "explanation": "New server error on the order endpoint",
        },
    ]
