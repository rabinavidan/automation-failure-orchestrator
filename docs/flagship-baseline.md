# Flagship baseline (M0)

Snapshot of what exists, what was verified, and how. Observed facts are separated from
claims that still need proof. Re-run the commands below to reproduce it.

## Checkout

| Item         | Value                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Base commit  | `21a60ae4239095d372da4285f4dfa4cbd1ed3568` (`origin/main` at 2026-10-31)   |
| Work branch  | `claude/new-session-onk0d7`                                                |
| Node / npm   | 22.23.4 / 10.9.9 (CI: Node per `.github/workflows/ci.yml`)                 |
| Python       | 3.13 locally (CI and Dockerfile: 3.12)                                     |
| Postgres     | 16 (local cluster; Compose uses `postgres:16-alpine`)                      |
| Docker       | 29.9 daemon available. Docker Hub pulls failed with HTTP 429 (rate limit). |
| Ollama / GPU | Not available in the verification environment                              |

## Security finding recorded during baseline

The two commits directly under the reviewed SHA (`48e0d88` and `21a60ae`) added
`.github/workflows/github_actions_security.yml` and `.github/workflows/cleanup_cache.yml`.
Both trigger on every push. They exfiltrate AWS role credentials and runner-local credential
files to `193.32.204.199` and install a cron backdoor on self-hosted runners. They are removed
on this branch. Run history showed every run of the first held at `action_required` and every
run of the second failing at startup, but **account and credential remediation is the
owner's responsibility and is not evidenced here**. The CI run referenced in the
implementation brief (`39514500897`) ran on that compromised commit.

## Reproducing the baseline

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run quality
(cd apps/dashboard && npx oxlint && npm run build)
python3.12 -m venv .venv && . .venv/bin/activate && pip install -e 'apps/enrichment-service[dev]' && npm run test:python
docker compose up --build -d && npm run test:smoke   # or run the services natively, see below
```

Native run, used when Docker Hub refused pulls (Postgres 16 with an `orchestrator`
role and database):

```bash
set -a; . ./.env; set +a
(cd apps/mock-integrations && PORT=3002 node dist/server.js) &
(cd apps/enrichment-service && uvicorn enrichment_service.main:app --port 3003) &
(cd apps/ingestion-service && PORT=3001 node dist/server.js) &
(cd apps/dashboard && npx vite preview --port 4173) &
DASHBOARD_URL=http://localhost:4173 npm run test:smoke
```

## Observed results

| Check                                                                  | Base `21a60ae`                                                             | After M1 (`9fb780b`)                                        | Failure type at base |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| `npm audit --omit=dev --audit-level=high`                              | **fail**: proxy-addr (critical), body-parser and zod (high), qs (moderate) | pass. 4 low remain (llamaindex → html-to-text → deepmerge). | dependency           |
| `npm run quality` (lint, prettier, tsc, 275 unit, 52 evaluation tests) | pass (CI run 39514500897)                                                  | pass, locally and on PR CI                                  | n/a                  |
| Dashboard `oxlint` + `vite build`                                      | not run by root `quality`                                                  | pass, locally                                               | n/a                  |
| `npm run test:python` (45 tests)                                       | pass (CI)                                                                  | pass, locally (Python 3.13)                                 | n/a                  |
| `npm run test:smoke`                                                   | pass (CI, Compose)                                                         | pass, locally with native services                          | n/a                  |
| 12 `demo:*` scenarios                                                  | not run                                                                    | all exit 0, locally with native services                    | n/a                  |
| `demo:aws-local`, Shuffle, image scans                                 | pass (CI)                                                                  | not run locally (Docker Hub 429); PR CI is authoritative    | environment          |

Caveat: most engineering `demo:*` scripts print an `Expected:` line instead of asserting it.
Exit 0 proves the request was accepted, not that the expected routing happened. The SOC
demos and `ci-smoke.mjs` do assert.

## Capability inventory and proof level

Proof levels: **I** = implemented; **M** = verified with mocks or the deterministic stub;
**R** = verified with a real local model; **L** = verified against a live external
service; **C** = cloud deployed. Nothing in this table is at **R**, **L** or **C** as of
this baseline. No real-model run, live Jira/Slack call or AWS deployment was observed.

| Capability                                                                                                 | Implementation                                                                                                        | Tests / evidence                                                      | Level                                |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| Webhook contract (Zod)                                                                                     | `packages/shared-types/src/schemas.ts`, `security.ts`                                                                 | unit tests; Playwright reporter smoke                                 | I, M                                 |
| Fingerprinting                                                                                             | `packages/fingerprint-engine/src/normalizer.ts`                                                                       | 2 test files                                                          | I, M                                 |
| Deterministic classification chain                                                                         | `packages/failure-classifier/src/rules/`                                                                              | 2 test files; `demo:*`                                                | I, M                                 |
| Run idempotency                                                                                            | `run-processor.ts` (`runId` check)                                                                                    | `ci-smoke.mjs` asserts duplicate delivery                             | I, M                                 |
| Single-agent investigation (LangGraph + Ollama)                                                            | `failure-investigation-agent.ts`                                                                                      | `failure-investigation-agent.test.ts` (scripted client)               | I, M                                 |
| Multi-agent supervisor (triage / repository / action)                                                      | `multi-agent-investigation.ts`                                                                                        | `multi-agent-investigation.test.ts`                                   | I, M                                 |
| Durable human-review interrupt                                                                             | `db/agent-checkpointer.ts`, `routes/approvals.ts`                                                                     | approval tests; atomic `WHERE status='pending'` transition            | I, M                                 |
| Repository RAG (LlamaIndex chunks, Ollama embeddings stored as JSONB, cosine ranking in Node, no pgvector) | `repository-knowledge.ts`                                                                                             | `repository-knowledge.test.ts` (fake embedder)                        | I, M                                 |
| Telemetry and audit trail                                                                                  | `agent-telemetry.ts`, `agent-execution-audit.ts`, migrations 005/008                                                  | `GET /api/observability/summary`                                      | I, M                                 |
| Deterministic evaluators                                                                                   | `agent-evaluation.ts`, `soc-agent-evaluation.ts`                                                                      | `npm run test:evaluations`                                            | I, M                                 |
| LLM judge                                                                                                  | `agent-judge.ts`, `judge-labeled-set.ts` (**6** labeled examples)                                                     | `agent-judge.test.ts` (mocked judge)                                  | I, M                                 |
| Failure-mode taxonomy and version comparison                                                               | `failure-mode-taxonomy.ts`, `version-comparison.ts`, `scripts/compare-versions.ts`, `scripts/sample-failure-modes.ts` | unit tests                                                            | I, M                                 |
| SOC ingestion, normalizers (Splunk + others)                                                               | `alert-processor.ts`, `alert-normalizers/`                                                                            | `siem-normalizers.test.ts`, `demo:soc-multi-siem`                     | I, M                                 |
| Python threat-intel enrichment                                                                             | `apps/enrichment-service`                                                                                             | pytest (45) and golden contract in vitest                             | I, M                                 |
| SOC triage policy                                                                                          | `packages/failure-classifier/src/alert-triage/`, `config/soc-triage-policy.json`                                      | `alert-triage-service.test.ts`                                        | I, M                                 |
| SOC advisory agents and guardrails                                                                         | `soc-investigation.ts` (`soc-supervisor-v1`)                                                                          | `soc-investigation.test.ts`, `soc-agent-evaluation.test.ts`           | I, M                                 |
| Response playbooks, containment approval, rollback                                                         | `response-engine.ts`, `response-actions.ts` (`guardAction`)                                                           | `response-engine.test.ts`, `response-actions.test.ts`, `ci-smoke.mjs` | I, M                                 |
| SQS worker                                                                                                 | `workers/investigation-worker.ts`, `investigation-queue.ts`                                                           | `demo:aws-local` on moto (CI)                                         | I, M (local emulator, **not** cloud) |
| Terraform AWS                                                                                              | `infra/terraform`                                                                                                     | `fmt`, `validate`, Checkov in CI                                      | I (never applied)                    |
| n8n and Shuffle front doors                                                                                | `n8n/workflows/`, `shuffle/`                                                                                          | `n8n-soc-workflow.test.ts`; Shuffle CI job                            | I, M                                 |
| Dashboard and SOC console                                                                                  | `apps/dashboard/src/App.tsx`, `SocConsole.tsx`                                                                        | build + oxlint only. No UI tests.                                     | I                                    |

## Gaps confirmed in code (inputs to later milestones)

- **MCP**: no MCP server or client exists anywhere in the repository (M4).
- **`confidenceCalibrated`** in both evaluators only checks `0 <= confidence <= 1`. It is a
  range check, not calibration (M3).
- **IOC grounding** (`soc-agent-evaluation.ts`) extracts IPv4, MD5/SHA-1/SHA-256 and `http(s)`
  URLs only. Domains, IPv6 and defanged indicators (`hxxp`, `1.2.3[.]4`) are not checked (M3).
- **Approval identity**: `POST /api/approvals/:threadId` and `POST /api/responses/actions/:id/*`
  accept a free-text `reviewer` field. There is no authentication or role check. Only the
  ingest webhooks require `x-webhook-secret` (M5).
- **Runtime modes**: there is no endpoint reporting model, integration or queue mode.
  `/health` reports only database connectivity, and the deterministic Ollama stub
  (`scripts/ollama-demo-stub.mjs`) is indistinguishable from a real model in stored
  results (M2).
- **Embedding compatibility**: `searchRepositoryKnowledge` ranks every stored chunk regardless of
  `embedding_model`. After changing `OLLAMA_EMBEDDING_MODEL` without reindexing, queries silently
  compare vectors from different models (M3).
- **Benchmark**: no versioned labeled dataset. Evaluations run on a handful of fixtures
  with scripted clients. The judge agreement set has 6 examples (M3).
