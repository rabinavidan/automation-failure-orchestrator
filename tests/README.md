# Test automation

Two test stacks, one per layer, each in the language that fits it:

| Layer                                                 | Tool                        | Location                   | Talks to the system through                                                      |
| ----------------------------------------------------- | --------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| Backend: contract, API, pipeline, SOC, agents, system | **pytest**                  | [`tests/backend`](backend) | HTTP APIs, PostgreSQL (read-only), mock integrations, the scriptable Ollama stub |
| UI: the operations dashboard                          | **Playwright (TypeScript)** | `tests/ui` (milestone 5)   | The browser, seeded through the API                                              |

Both are black-box: they test the running services, not internal functions, so they can be
pointed at any environment (local Docker, CI, a staging URL) through environment variables.

## Backend layers (pytest markers)

```text
smoke      is the stack up? fail fast
contract   payloads vs. JSON Schema generated from the Zod contracts (contracts/json-schema)
api        one endpoint: auth, validation, status codes
pipeline   CI failure pipeline: /api/runs -> PostgreSQL -> Jira -> Slack
soc        SOC alert pipeline: /api/alerts, triage, response actions
agents     advisory agents with scripted model replies (guardrails, fail-safe paths, approvals)
mcp        MCP evidence server: scope tokens, read-only tools
evaluation quality gates: benchmark regression vs. the committed baseline, agent output evaluators
drift      artefacts that must agree: n8n vs. API decisions, Azure vs. GitHub CI, playbooks,
           runbooks and the triage policy vs. their schemas
system     optional stacks: dashboard proxy, OpenTelemetry/Grafana, AWS-local (moto), Shuffle
harness    self-tests of the test framework itself
```

Run a layer with `pytest -m <marker>`. Markers are strict: an unknown marker fails the run.

`system` tests skip when their stack is not running, so one command works everywhere. A CI job
that starts a stack declares it in `REQUIRE_STACKS` (`dashboard`, `observability`, `aws-local`,
`shuffle`), which turns an unreachable stack into a failure instead of a silent skip.

## Design rules

- **One contract source.** `npm run contracts:export` turns the Zod schemas into JSON Schema;
  CI fails if the committed files are stale (`npm run contracts:check`). Factories are validated
  against the same schema, so test data can never drift from the real contract.
- **Independent tests.** Every factory call generates unique run IDs, test IDs and therefore
  fingerprints. Tests never truncate shared tables and pass in any order, repeatedly.
- **Assert outcomes, not calls.** A pipeline test checks the HTTP response, the rows in
  PostgreSQL and what reached Jira and Slack (the mock records every request).
- **Scripted model, not a model.** Agent tests script the Ollama stub's replies
  (`PUT /__scenario`): a high-risk assessment, invalid JSON, a 503. Real-model quality is
  measured separately by the [benchmark](../benchmark/README.md).
- **Typed and linted.** The suite passes `ruff` and `mypy --strict` in CI like product code.

## Run locally

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d \
  postgres mock-integrations enrichment-service ollama-stub ingestion-service ingestion-ai
pip install "./tests/backend[dev]"
npm run test:backend                      # or: cd tests/backend && pytest -m pipeline
```

Configuration: `INGESTION_URL`, `INGESTION_AI_URL`, `MOCK_URL`, `OLLAMA_STUB_URL`,
`TEST_DATABASE_URL`, `WEBHOOK_SECRET`, `MCP_SCOPE_SECRET` (defaults match the Compose stack on
localhost).

The test stack runs **two API instances** on one database: `ingestion-service` (:3001, agents
off) for deterministic layers, and `ingestion-ai` (:3011, agents on against the scripted stub,
MCP evidence enabled) for the `agents` and `mcp` layers. Deterministic tests therefore never
depend on model behaviour, and agent tests control it completely.
