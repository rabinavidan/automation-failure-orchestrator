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


def soc_run(
    *,
    evidence: list[str] | None = None,
    recommended: str = "contain",
    planner_risk: str = "high",
    runbooks: list[str] | None = None,
) -> list[Json | str]:
    """Scripted replies for soc-supervisor-v1: triage analyst, threat intel, response planner,
    supervisor."""
    return [
        specialist("triage analyst: repeated failed logins against one account"),
        specialist("threat intel: source IP is known malicious"),
        {
            **specialist("response planner: block the source"),
            "proposedResponse": recommended,
            "risk": planner_risk,
        },
        {
            "summary": "Brute force from a known-bad source",
            "attackNarrative": "Password guessing against a workstation account",
            "evidence": evidence or ["Failed logins from 203.0.113.7"],
            "recommendedResponse": recommended,
            "responseSteps": ["Block the source IP at the edge firewall"],
            "confidence": 0.8,
            "explanation": "Threat intel and the failed-login burst agree",
            "citedRunbooks": runbooks if runbooks is not None else ["credential-brute-force.md"],
        },
    ]
