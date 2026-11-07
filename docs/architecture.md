# Architecture

## Overview

The Bug-Aware Test Failure Orchestrator is a multi-service system that intelligently processes test failures, classifies them, and routes notifications to the appropriate channels.

## System Components

```
┌─────────────────────────────────────────────────────────┐
│                    CI Pipeline                          │
│  (GitHub Actions / Jenkins / CircleCI)                  │
└──────────────────────┬──────────────────────────────────┘
                       │ POST /webhook/test-results
                       ▼
┌─────────────────────────────────────────────────────────┐
│              n8n Workflow (thin front door)              │
│  Forwards the payload to POST /api/runs and relays the  │
│  API's decisions. No classification, no Jira or Slack.  │
└──────────────────────┬──────────────────────────────────┘
                       │ POST /api/runs
                       ▼
             Ingestion service: classification,
             policy, approval gate, Jira and Slack
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│                Ingestion Service (REST API)             │
│  - Persist run + test results to PostgreSQL             │
│  - Track failure history                                │
│  - Recovery detection                                   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    PostgreSQL                            │
│  - test_runs                                            │
│  - test_results                                         │
│  - failure_history                                      │
└─────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### SHA-256 Fingerprinting

Each test failure is fingerprinted using SHA-256 over:

- `testId | service | errorName | normalizedMessage | endpoint`

The message normalizer strips dynamic values (UUIDs, timestamps, request IDs) before hashing,
ensuring the same logical failure always produces the same fingerprint regardless of run.

### Classification Hierarchy

Failures are classified in priority order:

1. **KnownBug** — Jira issue already exists for this fingerprint
2. **InfrastructureFailure** — Error matches infra patterns (ECONNREFUSED, DNS, etc.)
3. **AutomationFailure** — Error matches test code patterns (strict mode, unknown fixture, etc.)
4. **FlakyTest** — Test passed on a retry in this run, OR its recent history oscillates (≥ 2 pass/fail transitions). A test that failed on every retry is not flaky.
5. **NewRegression** — Default: something in the app broke

### Idempotency

Run processing is idempotent via unique `runId` constraint. Duplicate submissions are detected
and return `{ duplicateRun: true }` without reprocessing.

### Recovery Detection

When a fingerprint linked to an open Jira issue passes `RECOVERY_PASS_THRESHOLD` (default: 3)
consecutive times, it's classified as `PossiblyFixed` and a Jira comment is added.

## Data Flow

```
Playwright tests → @orchestrator/playwright-reporter (one record per test, final outcome) → POST /api/runs
                                               │
                                               ▼
                                     POST /api/runs (ingestion-service)
                                               │
                                    ┌──────────┴──────────┐
                                    │                      │
                              Generate SHA-256       Zod Validation
                              Fingerprint
                                    │
                              Jira Label Search
                                    │
                              Classify failure
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             New Regression    Known Bug       Infra/Automation/Flaky
                    │               │               │
             Create Jira      Add Jira Comment   Slack only
             + Slack           + Slack
                    │               │               │
                    └───────────────┴───────────────┘
                                    │
                              Persist to DB
```

## Package Structure

- **`@orchestrator/shared-types`**: Zod schemas and TypeScript types for the webhook payload
- **`@orchestrator/fingerprint-engine`**: SHA-256 fingerprinting with message normalization
- **`@orchestrator/failure-classifier`**: Deterministic classification rules
- **`@orchestrator/ingestion-service`**: Express REST API for receiving and processing runs
- **`@orchestrator/mock-integrations`**: In-memory mock Jira and Slack server
- **`@orchestrator/playwright-reporter`**: Playwright reporter that emits the webhook contract
- **`@orchestrator/ui-tests`** (`tests/ui`): Playwright UI suite for the dashboard
