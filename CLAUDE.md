# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first platform that turns CI test failures into engineering actions: validate -> fingerprint -> classify -> investigate (multi-agent LangGraph + Ollama) -> apply deterministic policy -> act (Jira/Slack). Deterministic rules own every side effect; the LLM only advises. See README.md for the full architecture narrative, data flow, and API surface — it is kept detailed and current, so consult it before re-deriving design rationale here.

## Repository structure (npm workspaces)

```
apps/ingestion-service/   Express + Zod API, PostgreSQL, LangGraph multi-agent investigation, Jira/Slack policy actions
apps/mock-integrations/   In-memory Jira- and Slack-compatible APIs for local dev/demo (no tests)
apps/dashboard/           React 19 + Vite + Tailwind ops console (separate toolchain: oxlint, not the root ESLint config)
apps/test-suite/          Playwright scenarios + custom JSON reporter that normalizes results into the webhook contract
packages/shared-types/    Zod schemas + shared TS types (@orchestrator/shared-types) — the contract everything else depends on
packages/fingerprint-engine/  Deterministic normalization + SHA-256 failure identity (@orchestrator/fingerprint-engine)
packages/failure-classifier/  Priority-ordered deterministic classification rules (@orchestrator/failure-classifier)
database/migrations/      Numbered SQL migrations, applied in order at service startup
n8n/workflows/            Importable visual-orchestration alternative to the direct /api/runs path
scripts/                  demo:* scripts (npm run demo:<scenario>) and ci-smoke.mjs
```

Internal packages are referenced via workspace protocol (`"@orchestrator/x": "*"`) and TS path aliases in the root `tsconfig.json`. `shared-types` has no internal deps; `fingerprint-engine` and `failure-classifier` depend only on `shared-types`; `ingestion-service` depends on all three. Build order matters — build packages before apps that consume them (`npm run build` at the root handles this via workspaces).

## Commands

Run from the repo root unless noted.

```bash
npm install                       # installs all workspaces
npm run build                     # tsc --build across every workspace, if present
npm run lint                      # eslint . (root config; dashboard has its own oxlint)
npm run format:check              # prettier --check .
npm run test:unit                 # vitest run at the root (packages + ingestion-service; excludes apps/test-suite)
npm run test:evaluations          # deterministic agent-evaluation + multi-agent-investigation suites only
npm run quality                   # lint + format:check + build + test:unit + test:evaluations — the full local gate
npm run test:smoke                # scripts/ci-smoke.mjs
```

Single-workspace / single-test:

```bash
npm test --workspace=packages/fingerprint-engine
npm test --workspace=packages/failure-classifier
npm test --workspace=apps/ingestion-service

npx vitest run apps/ingestion-service/src/__tests__/failure-investigation-agent.test.ts
npx vitest run -t "test name substring"
```

Playwright test suite (separate from the vitest root config, has its own tsconfig):

```bash
npm test --workspace=apps/test-suite          # playwright test
npm run test:report --workspace=apps/test-suite
```

Local stack:

```bash
cp .env.example .env
docker compose up --build -d
bash scripts/setup-n8n.sh        # imports/activates the n8n workflow; needs Git Bash/WSL2 on Windows
curl -X POST http://localhost:3001/api/knowledge/reindex   # (re)build the RAG index when AI/RAG is enabled
```

Portfolio demo scenarios (`npm run demo:new-regression`, `demo:known-bug`, `demo:flaky-test`, `demo:infrastructure-failure`, `demo:automation-failure`, `demo:recovered-bug`, `demo:duplicate-delivery`) post canned payloads against the running stack — start Docker Compose first.

## Architecture notes worth knowing before editing

- **Contract-first**: `packages/shared-types` defines the Zod webhook/test-run contract and the `AgentInvestigation` shape. Changing it ripples into the fingerprint engine, classifier, ingestion routes, the Playwright reporter, and the n8n workflow's expectations — grep all of these before altering a schema.
- **Two entry points feed the same pipeline**: `POST /api/runs` (direct) and the n8n webhook (`n8n/workflows/main-workflow.json`) both terminate in the same deterministic classification + policy logic. Rule logic currently exists in both places; if you touch classification rules, check whether the n8n workflow duplicates the behavior.
- **`run-processor.ts` is the orchestration spine**: idempotency check on `runId` -> persist run -> per-test fingerprint -> Jira lookup by fingerprint label -> failure history lookup -> `classify()` (deterministic, priority-ordered in `packages/failure-classifier/src/rules/`) -> `investigateFailure()` (LLM, advisory only) -> policy-gated Jira/Slack actions -> history update.
- **Classification is a strict priority chain** (see README's "Deterministic decision engine" table): known_bug > infrastructure > automation_failure > flaky > new_regression, plus a recovery path. The LLM's `recommendedAction` never overrides this; it only adds evidence/explanation, except that `human_review` triggers a durable LangGraph interrupt requiring dashboard approval before any Jira/Slack call.
- **Multi-agent investigation** (`services/multi-agent-investigation.ts`, `failure-investigation-agent.ts`) is a LangGraph supervisor over three specialists (triage, repository, action) — each has an explicit "forbidden responsibility" (see README table). `MULTI_AGENT_ENABLED` toggles supervisor vs. single-agent mode; `AI_ENABLED=false` skips the LLM entirely and falls back to deterministic-only processing (this fallback also applies on schema-invalid output or Ollama timeout).
- **Fingerprints are identity, not just dedup**: `SHA256(testId | service | errorName | normalizedMessage | endpoint)` after stripping UUIDs/timestamps/request IDs/hex IDs/temp paths/dynamic ports (`packages/fingerprint-engine/src/normalizer.ts`). The first 12 hex chars become the Jira label used for exact-match correlation — don't confuse this with `runId` idempotency, which is a separate check in `run-processor.ts`.
- **Observability tables are append-only audit trails**: `agent_execution_events` (graph transitions/interrupts) and `agent_model_calls` (per-call model/tokens/latency) are written by `agent-execution-audit.ts` / `agent-telemetry.ts` and surfaced via `GET /api/observability/summary`. Evaluation gates (`services/agent-evaluation.ts`, covered by `npm run test:evaluations`) are deterministic code evaluators, not LLM judges.
- **Migrations are numbered SQL files** in `database/migrations/`, applied in order by `db/migrations.ts` at startup — add new ones with the next sequential prefix, don't edit existing ones.
- **Dashboard is same-origin via Nginx proxy** to ingestion (`:3001`) and mock-integrations (`:3002`) in Docker, avoiding CORS. `apps/dashboard` has its own lint/build toolchain (oxlint, Vite, Tailwind) independent of the root ESLint/Prettier/tsc setup — don't expect it to pick up root config changes.
- **Mock vs real integrations**: `INTEGRATION_MODE=mock` points Jira/Slack adapters at `apps/mock-integrations` (in-memory, resettable via `POST /reset`). Real credentials go through the same adapter interfaces (`services/jira-adapter.ts`, `services/slack-adapter.ts`).
