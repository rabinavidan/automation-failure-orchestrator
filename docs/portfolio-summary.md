# Portfolio summary: SignalOps

_Personal project. Source: https://github.com/rabinavidan/automation-failure-orchestrator_

## Short description

SignalOps turns noisy operational signals into evidence-backed investigations and controlled
actions. It has two tracks:

- **Engineering:** CI test failures are fingerprinted, classified and investigated, then
  ticketed.
- **Security:** SIEM alerts are deduplicated, enriched, triaged and investigated, with
  containment behind analyst approval.

Deterministic TypeScript code owns every decision and side effect. LangGraph agents running on
local Ollama models gather evidence and advise. A Python FastAPI service does threat-intel
enrichment. The project includes a labeled benchmark, an MCP evidence server with
server-enforced scope, role-checked approvals and a React operations console. It runs locally
at zero cost and has Terraform for AWS (validated and Checkov-scanned, never applied).

## CV bullets (verified work only)

- Built a contract-first incident-automation platform in TypeScript and Python (Express, Zod,
  PostgreSQL, LangGraph, FastAPI, React). Two domains (CI failures and SIEM alerts) share
  fingerprinting, deterministic decision chains, durable human-in-the-loop approvals and
  model-call telemetry. CI covers 300+ unit/service tests, Python tests, Docker smoke,
  Shuffle SOAR and an SQS worker on a local AWS emulator.
- Designed a reproducible investigation benchmark: 35 synthetic, AI-authored, family-split
  cases. It compares deterministic, single-agent and multi-agent configurations, refuses
  stub-backed runs, and reports policy compliance, unsupported claims, safety violations and
  cost separately. The deterministic baseline is 21/24 on CI cases and 11/11 on SOC cases
  ([report](../benchmark/results/baseline-deterministic/report.md)).
- Added a Model Context Protocol evidence server (Streamable HTTP) with HMAC scope tokens the
  model never sees. Tools are read-only and audited per call. Contract tests prove
  cross-investigation denial, bounded output and prompt-injection resistance. Reviewer
  approvals are role-checked, and CI asserts that four concurrent approvals produce exactly one
  transition.

## Interview pitch (30 seconds)

"An LLM that files tickets or blocks IPs on its own is a liability, so I built the opposite.
Rules decide, agents explain, humans approve risky actions. Every investigation records whether
a real model produced it. The benchmark refuses to score a stub. The MCP tools can only read
evidence for the investigation they were minted for. I can show the deterministic baseline
today, and the harness that will score a real model next."

## What not to claim

- No real-model benchmark results yet. Agent quality has not been measured on a real model.
- Benchmark labels are AI-authored and not human-validated.
- The AWS path ran only on a local emulator (moto). Nothing is deployed to the cloud.
- Reviewer auth is demo bearer tokens, not SSO. External actions after approval are not
  exactly-once.
- Jira, Slack, EDR and firewall integrations are mocks. Threat intel runs in mock mode by
  default.
