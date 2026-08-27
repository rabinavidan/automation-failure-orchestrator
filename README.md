# Agentic Test Failure Orchestrator

> A guarded, local-first Agentic AI platform that turns noisy CI test failures into evidence-backed engineering actions.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Ollama](https://img.shields.io/badge/Agentic_AI-Ollama-black)](https://ollama.com/)
[![n8n](https://img.shields.io/badge/Orchestration-n8n-EA4B71?logo=n8n&logoColor=white)](https://n8n.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Runtime-Docker_Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## Why this project exists

CI pipelines detect failures, but they do not decide what those failures mean. A red build can represent a new product regression, an existing bug, an unstable test, broken automation, or a temporary infrastructure problem. Treating every failure the same creates duplicate tickets, alert fatigue, and wasted investigation time.

This project demonstrates a different operating model:

```text
"A test failed"
       |
       v
Validate -> Fingerprint -> Classify -> Investigate -> Apply policy -> Act
       |          |            |              |              |
       |          |            |              |              +-> Jira / Slack
       |          |            |              +-> deterministic guardrails
       |          |            +-> Ollama agent + bounded tools
       |          +-> history-aware rules
       +-> Zod contract
```

The result is a portfolio-grade example of **AI automation as a complete system**, not an isolated LLM prompt: event ingestion, deterministic decisioning, agentic tool use, structured outputs, state, orchestration, integrations, testing, and safe degradation.

## What makes it technically interesting

- **Real agentic behavior**: a local Ollama model autonomously decides whether to call failure-history and Jira-context tools before returning its diagnosis.
- **Evidence-backed structured output**: every investigation contains a root-cause hypothesis, evidence, a recommended action, confidence, explanation, tools used, and model identity.
- **Guarded autonomy**: the model advises; deterministic policy controls Jira and Slack side effects. AI uncertainty or downtime cannot bypass operational rules.
- **Stable failure identity**: SHA-256 fingerprints are generated after removing UUIDs, timestamps, request IDs, numeric IDs, temporary paths, and dynamic ports.
- **Stateful classification**: PostgreSQL history enables recurrence detection, flaky-test detection, deduplication, and recovery signals across runs.
- **Idempotent processing**: duplicate `runId` deliveries are skipped, while fingerprint labels prevent duplicate Jira issues for the same logical failure.
- **Multi-system orchestration**: CI, Playwright, n8n, an Express API, PostgreSQL, Ollama, Jira, and Slack participate in one end-to-end workflow.
- **Local-first development**: the complete platform runs in Docker with mock Jira and Slack services; Ollama keeps inference local and avoids a mandatory paid model API.
- **Production-minded fallback**: if AI is disabled, unavailable, malformed, or exceeds its timeout, deterministic processing continues.
- **Operations dashboard**: a live React console combines CI runs, failure intelligence, persisted Agent investigations, Jira issues, and Slack notifications in one UI.

## Demonstrated agent outcome

The checkout failure scenario produced this real local-agent result:

```json
{
  "classification": "flaky",
  "slackSent": true,
  "agentInvestigation": {
    "suspectedRootCause": "External dependency failure (Payment Gateway)",
    "evidence": [
      "The server error reports that the payment gateway is unavailable.",
      "Recent pass/fail transitions indicate intermittent behavior.",
      "The HTTP 500 is consistent with dependency unavailability."
    ],
    "recommendedAction": "notify_only",
    "confidence": 0.9,
    "explanation": "The evidence supports a transient external dependency failure.",
    "toolsUsed": ["get_failure_history", "get_related_jira_issue"],
    "model": "gemma4:26b"
  }
}
```

The important part is not the prose. The agent selected tools, consumed state from other systems, produced a validated decision object, and operated inside an explicit safety boundary.

## Architecture

```text
                          +-----------------------+
                          | CI / GitHub Actions   |
                          | Playwright reporter   |
                          +-----------+-----------+
                                      |
                     normalized test-run contract
                                      |
                    +-----------------+-----------------+
                    |                                   |
                    v                                   v
          +-------------------+               +-------------------+
          | n8n webhook       |               | Ingestion API     |
          | visual workflow   |               | Express + Zod     |
          +---------+---------+               +---------+---------+
                    |                                   |
                    |                         +---------+----------+
                    |                         | fingerprint engine |
                    |                         | rules classifier   |
                    |                         | idempotency        |
                    |                         +---------+----------+
                    |                                   |
                    |                         +---------v----------+
                    |                         | LangGraph + Ollama |
                    |                         | bounded tools      |
                    |                         | checkpoints/audit  |
                    |                         +---------+----------+
                    |                                   |
                    +-----------------+-----------------+
                                      |
                           deterministic policy gate
                                      |
             +------------------------+------------------------+
             |                        |                        |
             v                        v                        v
      +-------------+          +-------------+          +-------------+
      | PostgreSQL  |          | Jira adapter|          |Slack adapter|
      | run/history |          | create/update          | notify      |
      +-------------+          +------+------+          +------+------+
                                     |                        |
                                     +-----------+------------+
                                                 |
                                      +----------v-----------+
                                      | local mock services  |
                                      | or real integrations |
                                      +----------------------+
```

### Two integration paths

The repository deliberately supports two entry points:

1. **Direct API path**: demos and other producers send a full test-run contract to `POST /api/runs`. This executes validation, persistence, deterministic classification, agent investigation, and integration actions.
2. **Visual orchestration path**: CI can send results to the n8n webhook. The workflow exposes validation, splitting, fingerprinting, routing, Jira/Slack calls, and persistence as an inspectable automation graph.

This demonstrates both code-first orchestration and low-code workflow automation. In a production consolidation, n8n would normally remain the external orchestrator while the ingestion service owns domain decisions, preventing duplicated business logic.

## Agent design

The Agentic AI layer is intentionally narrow and auditable.

### Agent goal

Investigate one failed test, identify the most plausible root cause, and recommend the safest next action without inventing evidence.

### Available tools

| Tool                     | Purpose                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `get_failure_history`    | Retrieves recurrence counts, recent statuses, consecutive passes, and the linked Jira key for the exact fingerprint |
| `get_related_jira_issue` | Retrieves the Jira issue associated with the exact fingerprint, if present                                          |
| `search_repository_context` | Uses local embeddings to retrieve cited code and documentation chunks from the allowlisted repository knowledge base |

### Structured decision contract

The model response is parsed and validated with Zod:

```ts
type AgentInvestigation = {
  suspectedRootCause: string;
  evidence: string[];
  recommendedAction: 'create_issue' | 'update_issue' | 'notify_only' | 'human_review';
  confidence: number; // 0..1
  explanation: string;
  toolsUsed: string[];
  model: string;
};
```

### Safety model

```text
LLM recommendation
       |
       v
schema validation ---- invalid/timeout ----> deterministic fallback
       |
       v
policy-owned classification
       |
       +-> human_review -> durable interrupt -> operator approve/reject -> resume thread
       |
       +-> new regression -> create Jira + notify Slack
       +-> known bug     -> update Jira + notify Slack
       +-> flaky/infra   -> notify Slack only
       +-> automation    -> notify Slack only
```

The agent does not override deterministic classification. When it recommends `human_review`, LangGraph persists an interrupt before any Jira or Slack side effect. An operator can approve or reject from the dashboard; the API resumes the exact checkpoint using the same thread ID. This preserves deterministic policy while adding explicit human authority for ambiguous cases.

## Deterministic decision engine

Rules run in an explicit priority order:

| Priority | Classification       | Signal                                                                               | Default action       |
| -------: | -------------------- | ------------------------------------------------------------------------------------ | -------------------- |
|        1 | `known_bug`          | Exact fingerprint already has a Jira issue                                           | Add comment + Slack  |
|        2 | `infrastructure`     | DNS, connection, timeout, gateway, browser, pod, or similar infrastructure signature | Slack only           |
|        3 | `automation_failure` | Selector, strict-mode, fixture, module, or syntax failure                            | Slack only           |
|        4 | `flaky`              | Retry occurred or recent history oscillates                                          | Slack only           |
|        5 | `new_regression`     | No earlier rule matched                                                              | Create Jira + Slack  |
| Recovery | `possibly_fixed`     | Known failure passes the consecutive-run threshold                                   | Jira comment + Slack |

This hybrid design is deliberate: deterministic logic handles repeatable policy; AI handles ambiguous interpretation and explanation.

## Failure fingerprinting

Each logical failure receives a deterministic identity:

```text
SHA256(testId | service | errorName | normalizedMessage | endpoint)
```

Normalization replaces runtime-specific noise before hashing:

| Dynamic value               | Normalized representation |
| --------------------------- | ------------------------- |
| UUID                        | `<UUID>`                  |
| ISO timestamp               | `<TIMESTAMP>`             |
| Request/session identifier  | `<REQ_ID>`                |
| Long hexadecimal identifier | `<HEX_ID>`                |
| Temporary path              | `/tmp/<TEMP>`             |
| Dynamic port in a URL       | `:<PORT>/`                |
| Large numeric identifier    | `<NUM>`                   |

The first 12 fingerprint characters become a Jira label such as `automation-fingerprint-5e2d4c0e440f`, enabling fast exact-match correlation.

## End-to-end data flow

1. Playwright executes tests.
2. The custom reporter converts framework output into a versioned JSON contract.
3. Zod rejects invalid payloads at the service boundary.
4. A unique `runId` check provides delivery idempotency.
5. Test runs and individual outcomes are stored in PostgreSQL.
6. Failed tests receive normalized SHA-256 fingerprints.
7. The system retrieves Jira context and historical status transitions.
8. Deterministic rules classify the failure.
9. When enabled, the Ollama agent chooses investigation tools and returns a structured recommendation.
10. LangGraph persists node-level checkpoints and a human-readable execution timeline in PostgreSQL.
11. Policy creates or updates Jira and routes Slack notifications.
12. Failure history is updated for future flaky and recovery detection.

## Technology choices

| Concern           | Technology                           | Engineering rationale                                                                |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| Agentic reasoning | LangGraph.js + Ollama                | Explicit state graph, bounded tool loops, local inference, and structured output      |
| Retrieval         | LlamaIndex TS + nomic-embed-text     | Local semantic chunking and embeddings with cited repository evidence                 |
| Domain language   | TypeScript 5                         | Shared contracts and strict typing across packages and services                      |
| API               | Node.js 24 + Express                 | Explicit service boundary with native `fetch` support                                |
| Validation        | Zod                                  | Runtime validation aligned with TypeScript types                                     |
| State             | PostgreSQL 16 + LangGraph checkpointer | Durable graph threads, restart-safe checkpoints, relational history, and JSONB audit |
| Orchestration     | n8n                                  | Inspectable event workflow and integration routing                                   |
| Test ingestion    | Playwright custom reporter           | Framework output normalized at the source                                            |
| Reliability logic | Rules + SHA-256                      | Explainable classification and correlation                                           |
| Integrations      | Jira + Slack adapters                | Separation between domain decisions and external APIs                                |
| Local runtime     | Docker Compose                       | Reproducible multi-service startup and health checks                                 |
| Quality           | Vitest, Playwright, ESLint, Prettier | Unit, integration, E2E, and static-quality coverage                                  |
| CI/CD             | GitHub Actions                       | Build, lint, tests, artifacts, and optional n8n delivery                             |

## Repository structure

```text
automation-failure-orchestrator/
|-- apps/
|   |-- ingestion-service/       # API, DB, policy actions, Ollama agent
|   |-- mock-integrations/       # In-memory Jira and Slack-compatible APIs
|   `-- test-suite/              # Playwright scenarios and JSON reporter
|-- packages/
|   |-- failure-classifier/      # Deterministic classification rules
|   |-- fingerprint-engine/      # Normalization and SHA-256 identity
|   `-- shared-types/            # Zod schemas and shared contracts
|-- database/migrations/         # PostgreSQL schema and indexes
|-- n8n/workflows/               # Importable visual workflow
|-- scripts/                     # Repeatable behavioral demos
|-- docs/                        # Architecture, API, and scenarios
|-- .github/workflows/ci.yml     # CI pipeline
`-- docker-compose.yml           # Local multi-service environment
```

## Quick start

### Prerequisites

- Docker Desktop with Compose v2
- Node.js 24 and npm
- Git Bash or WSL2 for `scripts/setup-n8n.sh` on Windows
- Ollama only when agentic investigation is enabled

### Start the deterministic platform

```bash
npm install
cp .env.example .env
docker compose up --build -d
bash scripts/setup-n8n.sh
```

Verify the services:

```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:5678
```

### Enable local Agentic AI

Install Ollama, then pull a tool-capable model:

```bash
ollama pull qwen3:4b
ollama pull nomic-embed-text
```

Set these values in `.env` when the ingestion service runs in Docker:

```env
AI_ENABLED=true
OLLAMA_HOST=http://host.docker.internal:11434
OLLAMA_MODEL=qwen3:4b
OLLAMA_TIMEOUT_MS=30000
RAG_ENABLED=true
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

For a larger local model such as `gemma4:26b`, increase the timeout:

```env
OLLAMA_MODEL=gemma4:26b
OLLAMA_TIMEOUT_MS=120000
```

Recreate the service so Compose applies the environment:

```bash
docker compose up --build -d ingestion-service
```

Build or refresh the allowlisted repository knowledge index:

```bash
curl -X POST http://localhost:3001/api/knowledge/reindex
```

When running directly on the host, use `OLLAMA_HOST=http://localhost:11434`.

## Portfolio demo

Run these scenarios during an interview:

```bash
# New fingerprint: create Jira + Slack + AI investigation
npm run demo:new-regression

# Same logical failure: correlate instead of duplicating Jira
npm run demo:known-bug

# Retry/history signal: suppress ticket noise
npm run demo:flaky-test

# Network signature: infrastructure rather than product bug
npm run demo:infrastructure-failure

# Test-code signature: automation failure
npm run demo:automation-failure

# Consecutive passes: possibly fixed
npm run demo:recovered-bug

# Same runId twice: delivery idempotency
npm run demo:duplicate-delivery
```

Inspect results:

| System           | URL                                  |
| ---------------- | ------------------------------------ |
| SignalOps UI     | http://localhost:4173                |
| Ingestion health | http://localhost:3001/health         |
| Recent runs      | http://localhost:3001/api/runs       |
| Failure history  | http://localhost:3001/api/failures   |
| n8n executions   | http://localhost:5678                |
| Mock Jira        | http://localhost:3002/jira/issues    |
| Mock Slack       | http://localhost:3002/slack/messages |

Reset only mock integration state:

```bash
curl -X POST http://localhost:3002/reset
```

### SignalOps dashboard

Open [http://localhost:4173](http://localhost:4173) after `docker compose up --build -d`. The dashboard refreshes every 15 seconds and provides:

- a command center with run, fingerprint, investigation, and confidence metrics
- searchable failure intelligence with status-transition history
- persisted Agent root cause, evidence, confidence, action, model, and tool audit trail
- checkpoint-backed LangGraph execution timelines with node status and tool transitions
- a local RAG control plane with index status, reindexing, semantic search, scores, and citations
- Jira issue cards and an operator-friendly Slack message stream
- drill-down failure dossiers instead of raw JSON as the primary UI

It uses same-origin Nginx proxies to the ingestion and mock-integration services, avoiding browser CORS coupling while keeping service boundaries explicit.

### What to explain in an interview

- Why model reasoning is separated from side-effect authorization.
- Why exact normalized fingerprints come before semantic similarity.
- How `runId` idempotency differs from failure deduplication.
- Why failure history belongs in PostgreSQL rather than prompt context alone.
- How bounded tools reduce hallucination and data exposure.
- How processing continues when Ollama is down or slow.
- Where n8n adds visibility and where code should remain the source of truth.
- How the architecture can expand to repository search, logs, approvals, and evaluation.

## n8n workflow

The workflow at `n8n/workflows/main-workflow.json` contains:

```text
Webhook -> Validate -> Split -> Filter failures -> Fingerprint
        -> Search Jira -> Classify -> Route
        -> Jira / Slack -> Persist -> Respond
```

Automated import:

```bash
bash scripts/setup-n8n.sh
```

The script waits for n8n, creates or reuses the local owner, logs in, removes the workflow `tags` field for compatibility, imports or updates the workflow, and attempts activation.

Webhook:

```text
POST http://localhost:5678/webhook/test-results
```

Local credentials are development-only:

```text
URL:      http://localhost:5678
Email:    admin@orchestrator.local
Password: Orchestrator123!
```

Change them outside local development.

## API surface

### Ingestion service (`:3001`)

| Method | Endpoint                                | Purpose                         |
| ------ | --------------------------------------- | ------------------------------- |
| `GET`  | `/health`                               | Service and database readiness  |
| `POST` | `/api/runs`                             | Validate and process a test run |
| `GET`  | `/api/runs`                             | Paginated run history           |
| `GET`  | `/api/runs/:runId`                      | Run and individual results      |
| `GET`  | `/api/failures`                         | Paginated failure aggregates    |
| `GET`  | `/api/failures/:fingerprint`            | History and recent occurrences  |
| `POST` | `/api/failures/:fingerprint/reclassify` | Human/manual correction         |

`POST /api/runs` requires:

```text
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>
```

Detailed examples are in [`docs/api.md`](docs/api.md).

### Mock integration service (`:3002`)

| Area             | Capability                                             |
| ---------------- | ------------------------------------------------------ |
| Jira-compatible  | Create issue, search by label, read issue, add comment |
| Slack-compatible | Receive webhook and list messages                      |
| Utilities        | Health and state reset                                 |

Mock mode makes the workflow demonstrable without external accounts. Real Jira and Slack endpoints can be supplied through environment variables.

## Data model

| Table               | Responsibility                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| `test_runs`         | One record per delivered CI run; unique `run_id` enforces idempotency              |
| `test_results`      | Outcomes, errors, artifacts, fingerprint, classification, and Jira link            |
| `failure_history`   | Counts, recent statuses, consecutive passes, and issue correlation per fingerprint |
| `schema_migrations` | Applied SQL migration tracking                                                     |

Indexes cover run lookup, branch/time queries, fingerprint correlation, classification, Jira keys, and recent failures.

## Testing and CI

```bash
# Compile every workspace
npm run build

# Unit and service tests
npm test

# Targeted packages
npm test --workspace=packages/fingerprint-engine
npm test --workspace=packages/failure-classifier
npm test --workspace=apps/ingestion-service
```

The Playwright project intentionally includes successful, failing, flaky, infrastructure, and automation scenarios. Its custom reporter writes:

```text
apps/test-suite/test-results/normalized-results.json
```

GitHub Actions performs linting, formatting checks, workspace builds, unit tests, browser tests, artifact upload, and optional delivery to n8n when secrets are configured.

## Configuration

| Variable                  | Default                          | Purpose                                |
| ------------------------- | -------------------------------- | -------------------------------------- |
| `DATABASE_URL`            | local PostgreSQL                 | Run and history storage                |
| `WEBHOOK_SECRET`          | `local-dev-secret`               | Ingestion authentication               |
| `INTEGRATION_MODE`        | `mock`                           | Mock or real integrations              |
| `JIRA_BASE_URL`           | mock service URL                 | Jira-compatible API base               |
| `JIRA_PROJECT_KEY`        | `AUTO`                           | Project for new issues                 |
| `JIRA_EMAIL`              | local placeholder                | Real Jira identity                     |
| `JIRA_API_TOKEN`          | local placeholder                | Real Jira credential                   |
| `SLACK_WEBHOOK_URL`       | mock webhook                     | Slack destination                      |
| `RECOVERY_PASS_THRESHOLD` | `3`                              | Passes before `possibly_fixed`         |
| `FLAKY_HISTORY_WINDOW`    | `5`                              | Outcomes considered by flaky detection |
| `AI_ENABLED`              | `false`                          | Enable Ollama investigation            |
| `OLLAMA_HOST`             | `localhost:11434` outside Docker | Ollama server                          |
| `OLLAMA_MODEL`            | `qwen3:4b`                       | Tool-capable model                     |
| `OLLAMA_TIMEOUT_MS`       | `30000`                          | Per-request AI timeout                 |
| `RAG_ENABLED`             | `true`                           | Enable bounded repository retrieval    |
| `OLLAMA_EMBEDDING_MODEL`  | `nomic-embed-text`               | Local semantic embedding model         |
| `PORT`                    | `3001`                           | Ingestion port                         |
| `MOCK_PORT`               | `3002`                           | Mock service port                      |

Never commit production Jira tokens, Slack webhooks, webhook secrets, or n8n encryption keys.

## Engineering trade-offs

### Why not let the LLM create tickets directly?

Ticket creation is a costly side effect. Deterministic authorization makes behavior reproducible and testable while the agent contributes context where probabilistic reasoning is valuable.

### Why exact fingerprints instead of embeddings first?

Exact normalized correlation is cheap, explainable, and resistant to runtime noise. Semantic similarity is a useful future fallback for near-duplicates, not a replacement for exact identity.

### Why keep n8n and an application service?

n8n provides workflow visibility and integration agility. The TypeScript service provides versioned contracts, tests, stateful domain logic, and a safe home for the agent. Production evolution should keep domain decisions centralized rather than duplicated.

### Why local Ollama?

CI failures can contain source paths, stack traces, endpoints, and operational context. Local inference provides privacy, cost control, offline operation, and model portability. The trade-off is hardware-dependent latency and quality.

## Current limitations and roadmap

- Agent investigations, execution events, and LangGraph checkpoints are persisted; prompt/version lineage and token-level telemetry are not yet captured.
- Repository code and documentation are searchable; Git diffs, distributed traces, and centralized logs are not yet indexed.
- Approval decisions are local-operator controls; production identity, RBAC, and signed audit identity are not yet implemented.
- Mock Jira and Slack state is in memory.
- Rule logic exists in both n8n and the ingestion path; production should consolidate the source of truth.
- Local-model latency depends on model size, hardware, and cold-start state.
- Real integrations still need production authentication, retries, rate limits, circuit breakers, and secret management.

Planned evolution:

1. Add prompt/version lineage, latency, token, and model-quality telemetry to persisted agent decisions.
2. Extend local RAG with Git diff, log, and trace ingestion.
3. Build evaluations for hallucination, tool selection, policy agreement, and unsafe actions.
4. Add semantic clustering after exact fingerprint matching.
5. Add OpenTelemetry, operational metrics, retries, circuit breakers, and an action outbox.
6. Add production authentication and role-based approval policies.

## Professional competencies demonstrated

This repository is designed to show more than framework familiarity:

- system decomposition across CI, orchestration, services, state, AI, and integrations
- safe integration of probabilistic AI into deterministic operational workflows
- API and event-contract design with runtime validation
- idempotency, deduplication, recovery, and graceful degradation
- tool-using agent design with bounded authority and structured outputs
- relational data modeling and history-aware decisions
- test automation, custom reporting, CI/CD, and reproducible environments
- explicit trade-off analysis and an incremental path from prototype to production

## Documentation

- [`docs/architecture.md`](docs/architecture.md) - component and data-flow details
- [`docs/api.md`](docs/api.md) - API contracts and examples
- [`docs/demo-scenarios.md`](docs/demo-scenarios.md) - scenario walkthroughs
- [`n8n/credentials.example.md`](n8n/credentials.example.md) - credential guidance

## License and use

This repository is an engineering portfolio and reference implementation. Review security, authentication, retention, and operational requirements before adapting it for production use.
