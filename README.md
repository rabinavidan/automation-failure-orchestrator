# Bug-Aware Test Failure Orchestrator

A portfolio-ready system that intelligently processes CI test failures, classifies them using deterministic rules, and routes notifications to Jira and Slack — reducing alert fatigue by distinguishing new regressions from known bugs, flaky tests, and infrastructure failures.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [n8n Setup](#n8n-setup)
- [Running Demo Scenarios](#running-demo-scenarios)
- [Viewing Results](#viewing-results)
- [Running Tests](#running-tests)
- [Running Playwright Tests](#running-playwright-tests)
- [Environment Variables](#environment-variables)
- [How Fingerprinting Works](#how-fingerprinting-works)
- [How Classification Works](#how-classification-works)
- [Mock vs Real Integrations](#mock-vs-real-integrations)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

---

## Features

- **SHA-256 Fingerprinting** — Normalizes error messages (strips UUIDs, timestamps, request IDs, temp paths) so the same logical failure always produces the same fingerprint across runs
- **Deterministic Classification** — Rules-based with no ML required:
  - `new_regression` — Unknown failure → creates Jira issue
  - `known_bug` — Fingerprint matches open Jira issue → adds comment
  - `flaky` — Retry-based or history-based detection → Slack only
  - `infrastructure` — ECONNREFUSED, DNS, gateway errors → Slack only
  - `automation_failure` — Missing selector, strict mode, bad fixture → Slack only
  - `possibly_fixed` — Consecutive passes after known bug → Jira comment + Slack
- **Idempotency** — Duplicate run IDs are detected and skipped; same fingerprint never creates two Jira issues
- **n8n Workflow** — Visual orchestration: webhook → fingerprint → classify → Jira/Slack/DB
- **Custom Playwright Reporter** — Outputs normalized JSON matching the webhook schema exactly
- **Mock Integrations** — Full local development without any paid services

---

## Architecture

```
CI / Demo Script
      │
      │  POST /api/runs
      ▼
┌─────────────────────┐
│  Ingestion Service  │  :3001
│  - Validate (Zod)   │
│  - Fingerprint      │
│  - Classify         │
│  - Persist (PG)     │
└────────┬────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐  ┌─────────────────┐
│  n8n  │  │  PostgreSQL      │
│ :5678 │  │  test_runs       │
│       │  │  test_results    │
│  ┌────┤  │  failure_history │
│  │ Jira│  └─────────────────┘
│  │ Slack│
│  └────┤
└───────┘
    │
    ▼
┌────────────────────┐
│ Mock Integrations  │  :3002
│ /jira/issues       │
│ /slack/messages    │
└────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for full details.

---

## Prerequisites

- **Docker Desktop** (with Compose v2) — `docker compose version`
- **Node.js 18+** — `node --version`
- **npm 9+** — `npm --version`

> On Windows, run commands in Git Bash or WSL2, not CMD/PowerShell.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file — defaults work out of the box for local dev
cp .env.example .env

# 3. Start all Docker services
docker compose up --build -d

# 4. Set up n8n (one-time — creates owner account + imports workflow)
bash scripts/setup-n8n.sh

# 5. Verify everything is healthy
curl http://localhost:3001/health   # {"status":"ok","database":"connected"}
curl http://localhost:3002/health   # {"status":"ok","jiraIssues":0,...}
curl http://localhost:5678          # n8n UI (HTTP 200)

# 6. Run a demo
npm run demo:new-regression
```

---

## n8n Setup

n8n is the visual orchestration layer. It must be set up once after the first `docker compose up`.

### Automated Setup (recommended)

```bash
bash scripts/setup-n8n.sh
```

This script:
1. Waits for n8n to be ready
2. Creates the owner account
3. Imports `n8n/workflows/main-workflow.json`
4. Activates the workflow

### Manual Setup (alternative)

If you prefer the browser UI:

1. Open [http://localhost:5678](http://localhost:5678)
2. Complete the **Setup** wizard:
   - Email: any email you choose (e.g. `admin@orchestrator.local`)
   - Password: at least 8 characters (e.g. `Orchestrator123!`)
3. Go to **Workflows** → **Add Workflow** → **Import from File**
4. Select `n8n/workflows/main-workflow.json`
5. Click **Save**, then click the **Active** toggle to enable the workflow

> **Important:** The workflow JSON contains a `tags` field that can cause a constraint error on fresh installs. The automated script strips it automatically. If importing manually via UI and you hit an error, open `n8n/workflows/main-workflow.json`, remove the `"tags": [...]` field, save, and re-import.

### n8n Credentials

After running `setup-n8n.sh`:

| Field | Value |
|---|---|
| URL | http://localhost:5678 |
| Email | `admin@orchestrator.local` |
| Password | `Orchestrator123!` |

These are local-only dev credentials. Change them for any non-local deployment.

### Webhook URL

Once the workflow is active, it listens at:

```
POST http://localhost:5678/webhook/test-results
```

### Verify the Workflow Is Receiving

```bash
curl -s -X POST http://localhost:5678/webhook/test-results \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: local-dev-secret" \
  -d '{
    "schemaVersion":"1.0.0",
    "runId":"ping-001",
    "repository":"test",
    "branch":"main",
    "commitSha":"abc123",
    "environment":"local",
    "triggeredBy":"manual",
    "startedAt":"2026-01-01T10:00:00Z",
    "finishedAt":"2026-01-01T10:01:00Z",
    "summary":{"total":1,"passed":1,"failed":0,"skipped":0},
    "tests":[]
  }'
```

An execution should appear at [http://localhost:5678](http://localhost:5678) → **Executions**.

---

## Running Demo Scenarios

All demos send payloads to the ingestion service (`http://localhost:3001/api/runs`). Make sure all services are running first.

### Demo 1 — New Regression

```bash
npm run demo:new-regression
```

A previously unseen failure. Expected result:
- `classification: "new_regression"`
- Mock Jira issue created (e.g. `MOCK-1`)
- Slack notification sent

### Demo 2 — Known Bug

```bash
npm run demo:known-bug
```

Same fingerprint as demo 1, sent twice. Expected result:
- Both runs: `classification: "known_bug"`, `jiraKey: "MOCK-1"`
- No duplicate Jira issue created
- Comment added to existing issue

### Demo 3 — Flaky Test

```bash
npm run demo:flaky-test
```

A test with `retry: 1` (failed on first attempt, retried). Expected result:
- `classification: "flaky"`
- No Jira action
- Slack notification only

### Demo 4 — Infrastructure Failure

```bash
npm run demo:infrastructure-failure
```

`ECONNREFUSED` / DNS error pattern. Expected result:
- `classification: "infrastructure"`
- No Jira action
- Slack notification only

### Demo 5 — Automation Failure

```bash
npm run demo:automation-failure
```

Playwright `strict mode violation` (test code bug, not app regression). Expected result:
- `classification: "automation_failure"`
- No Jira action
- Slack notification only

### Demo 6 — Recovered Bug

```bash
# First establish a known bug
npm run demo:new-regression

# Then send 3 consecutive passes for the same fingerprint
npm run demo:recovered-bug
```

Expected result after 3 passes:
- `classification: "possibly_fixed"`
- Jira comment added asking for verification
- Slack notification

### Demo 7 — Duplicate Delivery

```bash
npm run demo:duplicate-delivery
```

Same `runId` sent twice. Expected result:
- First request: `201` — processed normally
- Second request: `200` with `duplicateRun: true` — no reprocessing, no duplicate Jira issue

---

## Viewing Results

After any demo, inspect results here:

| What to check | Where |
|---|---|
| n8n execution history | [http://localhost:5678](http://localhost:5678) → Executions |
| Mock Jira issues | [http://localhost:3002/jira/issues](http://localhost:3002/jira/issues) |
| Mock Slack messages | [http://localhost:3002/slack/messages](http://localhost:3002/slack/messages) |
| All test runs (API) | `GET http://localhost:3001/api/runs` |
| Failure history (API) | `GET http://localhost:3001/api/failures` |

Reset mock state (clears all mock Jira issues and Slack messages) without restarting:

```bash
curl -X POST http://localhost:3002/reset
```

---

## Running Tests

```bash
# All unit tests
npm test

# Specific packages
npm test --workspace=packages/fingerprint-engine
npm test --workspace=packages/failure-classifier
npm test --workspace=apps/ingestion-service
```

Expected output: **52 tests pass** across fingerprint-engine (19), failure-classifier (29), ingestion-service (4).

---

## Running Playwright Tests

```bash
cd apps/test-suite

# Install browser (first time only)
npx playwright install chromium

# Run tests
npm test

# The custom reporter writes normalized results to:
cat test-results/normalized-results.json

# Send those results to the ingestion service:
curl -X POST http://localhost:3001/api/runs \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: local-dev-secret" \
  -d @test-results/normalized-results.json
```

The test suite includes intentional failures (product failure, known bug, flaky simulation) to exercise the full classification pipeline.

---

## Environment Variables

Copy `.env.example` to `.env`. All defaults work for local development with mock integrations.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://orchestrator:orchestrator@localhost:5432/orchestrator` | PostgreSQL connection string |
| `N8N_WEBHOOK_URL` | `http://localhost:5678/webhook/test-results` | n8n webhook endpoint |
| `N8N_ENCRYPTION_KEY` | `change-me-in-production` | n8n internal encryption key |
| `N8N_USER` | `admin` | n8n basic auth user (legacy, kept for reference) |
| `N8N_PASSWORD` | `change-me-in-production` | n8n basic auth password (legacy) |
| `INTEGRATION_MODE` | `mock` | `mock` uses local mock server; `real` uses live Jira/Slack |
| `WEBHOOK_SECRET` | `local-dev-secret` | Secret verified in `x-webhook-secret` header |
| `JIRA_BASE_URL` | `http://localhost:3002` | Jira API base (mock or real) |
| `JIRA_PROJECT_KEY` | `AUTO` | Jira project key for new issues |
| `JIRA_EMAIL` | `test@example.com` | Jira account email (real mode only) |
| `JIRA_API_TOKEN` | `mock-token` | Jira API token (real mode only) |
| `SLACK_WEBHOOK_URL` | `http://localhost:3002/slack/services/T00/B00/xxx` | Slack webhook URL |
| `RECOVERY_PASS_THRESHOLD` | `3` | Consecutive passes before marking `possibly_fixed` |
| `FLAKY_HISTORY_WINDOW` | `5` | Number of recent runs used for flaky detection |
| `AI_ENABLED` | `false` | Enable optional AI failure summaries |
| `AI_API_KEY` | _(empty)_ | OpenAI-compatible API key |
| `AI_MODEL` | `gpt-4o-mini` | Model used for AI summaries |
| `PORT` | `3001` | Ingestion service port |
| `MOCK_PORT` | `3002` | Mock integrations port |

---

## How Fingerprinting Works

Each failure gets a deterministic SHA-256 fingerprint computed from:

```
fingerprint = SHA256(testId | service | errorName | normalizedMessage | endpoint)
```

Before hashing, the error message is normalized — these patterns are stripped:

| Pattern | Example removed |
|---|---|
| UUIDs | `550e8400-e29b-41d4-a716-446655440000` |
| ISO timestamps | `2026-08-16T10:00:00.000Z` |
| Request / session IDs | `req-abc123`, `sess-xyz789` |
| Hex IDs (8+ chars) | `deadbeef`, `0a1b2c3d` |
| Temp paths | `/tmp/playwright-artifacts-abc` |
| Dynamic ports | `:54321` → `:<PORT>` |

This means the same logical failure (e.g. "checkout returns 500") always produces the same fingerprint regardless of which run, which machine, or which timestamp it came from.

The fingerprint is stored as a label on the Jira issue: `automation-fingerprint-<first12chars>`.

See [packages/fingerprint-engine](packages/fingerprint-engine/) for implementation and tests.

---

## How Classification Works

Classification is deterministic — no AI required. Rules are checked in priority order:

```
1. Known Bug       → fingerprint matches an open Jira issue
2. Infrastructure  → error matches: ECONNREFUSED, ENOTFOUND, gateway timeout,
                     browser launch failure, pod unavailable, ETIMEDOUT
3. Automation      → error matches: strict mode violation, missing selector,
                     unknown fixture, Cannot find module, SyntaxError
4. Flaky           → retry > 0, OR ≥2 status transitions in last 5 runs
5. New Regression  → none of the above
```

Recovery detection runs separately for passing tests: when a fingerprint linked to an open Jira issue passes `RECOVERY_PASS_THRESHOLD` consecutive times, it is marked `possibly_fixed`.

See [packages/failure-classifier](packages/failure-classifier/) for implementation and tests.

---

## Mock vs Real Integrations

Set `INTEGRATION_MODE` in `.env`:

```bash
INTEGRATION_MODE=mock   # default — uses http://localhost:3002
INTEGRATION_MODE=real   # uses live Jira and Slack credentials
```

**Mock mode** — all requests go to the mock-integrations service:
- Jira: `http://localhost:3002/jira/rest/api/2/`
- Slack: `http://localhost:3002/slack/services/T00/B00/xxx`
- View results: `http://localhost:3002/jira/issues` and `http://localhost:3002/slack/messages`

**Real mode** — requires live credentials in `.env`:
- `JIRA_BASE_URL` — your Atlassian instance (e.g. `https://yourorg.atlassian.net`)
- `JIRA_EMAIL` — Atlassian account email
- `JIRA_API_TOKEN` — generate at https://id.atlassian.com/manage-profile/security/api-tokens
- `SLACK_WEBHOOK_URL` — incoming webhook from https://api.slack.com/apps

---

## Project Structure

```
automation-failure-orchestrator/
├── apps/
│   ├── test-suite/           # Playwright tests + custom JSON reporter
│   ├── ingestion-service/    # Express REST API (port 3001)
│   └── mock-integrations/    # Mock Jira + Slack server (port 3002)
├── packages/
│   ├── shared-types/         # Zod schemas + TypeScript types
│   ├── fingerprint-engine/   # SHA-256 fingerprinting + normalizer
│   └── failure-classifier/   # Deterministic classification rules
├── n8n/
│   ├── workflows/
│   │   └── main-workflow.json
│   └── credentials.example.md
├── database/
│   └── migrations/           # 001_test_runs, 002_test_results, 003_failure_history
├── scripts/
│   ├── setup-n8n.sh          # One-time n8n setup script
│   ├── demo-new-regression.ts
│   ├── demo-known-bug.ts
│   ├── demo-flaky-test.ts
│   ├── demo-infra-failure.ts
│   ├── demo-automation-failure.ts
│   ├── demo-recovered-bug.ts
│   └── demo-duplicate-delivery.ts
├── docs/
│   ├── architecture.md
│   ├── demo-scenarios.md
│   └── api.md
├── .github/
│   └── workflows/
│       └── ci.yml
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md
```

---

## API Reference

See [docs/api.md](docs/api.md) for full request/response documentation.

Quick reference:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health + DB status |
| `POST` | `/api/runs` | Ingest a test run payload |
| `GET` | `/api/runs` | List all test runs |
| `GET` | `/api/runs/:runId` | Get a specific run |
| `GET` | `/api/failures` | List all failure fingerprints |
| `GET` | `/api/failures/:fingerprint` | Get history for a fingerprint |
| `POST` | `/api/failures/:fingerprint/reclassify` | Manually reclassify a failure |

All write endpoints require the `x-webhook-secret` header matching `WEBHOOK_SECRET` in `.env`.

---

## Troubleshooting

### Port 5678 already in use

n8n fails to start because another container (e.g. a previous n8n instance) is holding the port.

```bash
# Find and stop the conflicting container
docker ps | grep 5678
docker stop <container-name>

# Then restart
docker compose up -d n8n
```

### n8n workflow not receiving webhooks

1. Confirm the workflow is **active** — green toggle in the n8n UI, or:
   ```bash
   # Check via API (replace TOKEN with your JWT from login)
   curl -s http://localhost:5678/rest/workflows/main-workflow \
     -H "Cookie: n8n-auth=<TOKEN>" | grep '"active"'
   ```
2. The webhook URL must be `http://localhost:5678/webhook/test-results` (not `/webhook-test/`).
3. Re-run `bash scripts/setup-n8n.sh` to re-import and re-activate.

### n8n workflow import fails with constraint error

The workflow JSON includes a `tags` field that causes a SQLite constraint error on fresh installs. The `setup-n8n.sh` script strips it automatically. If importing manually, remove `"tags": [...]` from `n8n/workflows/main-workflow.json` before importing.

### Database migration error: value too long

The `schema_migrations.version` column defaults to `VARCHAR(20)` on a fresh install but migration filenames exceed 20 characters. This is auto-fixed on rebuild, or manually:

```bash
docker exec orchestrator-postgres psql -U orchestrator -d orchestrator \
  -c "ALTER TABLE schema_migrations ALTER COLUMN version TYPE VARCHAR(255);"
docker compose restart ingestion-service
```

### Ingestion service not connecting to database

The service runs migrations on startup and retries if the database isn't ready. If it keeps failing:

```bash
docker compose logs ingestion-service
docker compose restart ingestion-service
```

### demo scripts fail with connection refused

Make sure all services are running:

```bash
docker compose ps
# All four should show "Up" and healthy:
# orchestrator-postgres, orchestrator-n8n, orchestrator-ingestion, orchestrator-mock
```

If any are down: `docker compose up -d`

---

## Known Limitations

- **n8n workflow activation** — The n8n REST API returns `active: false` on PATCH for some workflow configurations. If the automated script reports this, activate manually in the UI at http://localhost:5678.
- **n8n auth cookie** — n8n sets `Secure` on its auth cookie, which curl drops over HTTP. The setup script works around this by extracting the token from response headers.
- **No GitHub Actions secrets** — The CI pipeline sends results to `N8N_WEBHOOK_URL` only when the secret is configured in the repo settings.
- **Mock data is in-memory** — The mock-integrations service loses all issues and messages on container restart. Use `GET /jira/issues` and `GET /slack/messages` to inspect state while running.
- **AI analysis (Phase 4)** — Not yet implemented. Set `AI_ENABLED=false` (the default).

---

## Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.x, Node.js 24 |
| Test runner | Playwright Test + custom JSON reporter |
| Unit tests | Vitest 2.x |
| Validation | Zod 3.x |
| REST API | Express 4.x |
| Database | PostgreSQL 16 + raw SQL migrations |
| Orchestration | n8n (self-hosted via Docker) |
| Containerization | Docker Compose v2 |
| Linting | ESLint 9 (flat config) + Prettier 3 |
