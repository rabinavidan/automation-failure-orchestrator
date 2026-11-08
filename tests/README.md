# Test automation

Two test stacks, one per layer, each in the language that fits it:

| Layer                                                 | Tool                        | Location                                                            | Talks to the system through                                                      |
| ----------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Backend: contract, API, pipeline, SOC, agents, system | **pytest**                  | [`tests/backend`](backend)                                          | HTTP APIs, PostgreSQL (read-only), mock integrations, the scriptable Ollama stub |
| UI: the operations dashboard                          | **Playwright (TypeScript)** | [`tests/ui`](ui)                                                    | The browser, seeded through the API                                              |
| Enrichment service (Python) internals                 | **pytest**                  | [`apps/enrichment-service/tests`](../apps/enrichment-service/tests) | The service's own functions and its FastAPI app in-process (respx for providers) |

The first two are black-box: they test the running services, not internal functions, so they can
be pointed at any environment (local Docker, CI, a staging URL) through environment variables.
The enrichment suite is the one unit-level layer, deliberately kept next to the Python service it
tests: it ships with that service's own `ruff` + `mypy --strict` + `pytest` gate (`npm run
test:python`) and its golden response contract, which `tests/backend/contract` also checks from the
TypeScript side.

No other test framework is used: the TypeScript services have no unit-test runner, and their
coverage is measured from the black-box pytest suite (see Coverage below).

## Backend layers (pytest markers)

```text
smoke      is the stack up? fail fast
contract   payloads and API responses vs. JSON Schema generated from the Zod contracts
api        one endpoint: auth, validation, status codes
pipeline   CI failure pipeline: /api/runs -> PostgreSQL -> Jira -> Slack
soc        SOC alert pipeline: /api/alerts, triage, response actions
agents     advisory agents with scripted model replies (guardrails, fail-safe paths, approvals)
mcp        MCP evidence server: scope tokens, read-only tools
evaluation quality gates: benchmark regression vs. the committed baseline, agent output evaluators
drift      artefacts that must agree: Markdown links and anchors resolve, OpenAPI vs. Express routes,
           n8n workflows stay front doors, Azure vs. GitHub CI, playbooks, runbooks and the triage
           policy vs. their schemas
system     optional stacks: dashboard proxy, OpenTelemetry/Grafana, AWS-local (moto), Shuffle, n8n
harness    self-tests of the test framework itself
```

Run a layer with `pytest -m <marker>`. Markers are strict: an unknown marker fails the run.

`system` tests skip when their stack is not running, so one command works everywhere. A CI job
that starts a stack declares it in `REQUIRE_STACKS` (`dashboard`, `observability`, `aws-local`,
`shuffle`, `n8n`), which turns an unreachable stack into a failure instead of a silent skip.

## Coverage

`npm run coverage:backend` measures how much of the TypeScript backend the black-box pytest
suite exercises: it starts the services natively (PostgreSQL on `:5432` required) under
`NODE_V8_COVERAGE` and runs `pytest -m "not system"` against them. A second phase covers the
queue path: moto (`pip install "moto[server]"`), an API instance with `INVESTIGATION_QUEUE=sqs`
and the investigation worker, driven by the AWS-local system test. Every process is then shut
down gracefully and c8 maps V8 coverage back to TypeScript. Modules no test loads count as 0%. The gate is 80% lines
and 70% branches (`COVERAGE_LINES`, `COVERAGE_BRANCHES`); the HTML report lands in
`coverage/backend/`. CI job **Backend coverage** runs it on every push.

Not measured, by design: static labeled datasets (`judge-labeled-set.ts`), which are data,
not behaviour.

## Demo scripts are not tests

`npm run demo:*` scripts are presentation walkthroughs for a running stack: they print what
happens and stop only if the stack is unreachable. Every behaviour a demo shows is pinned by a
pytest test, so a demo can never be the only evidence:

| Demo                                                     | Pinned by                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `demo:new-regression`                                    | `pipeline/test_new_regression.py::test_new_failure_opens_one_jira_issue_and_notifies_slack`             |
| `demo:duplicate-delivery`                                | `pipeline/test_new_regression.py::test_redelivered_run_is_idempotent`                                   |
| `demo:known-bug`                                         | `pipeline/test_classification.py::test_known_bug_comments_on_the_existing_issue_instead_of_opening_one` |
| `demo:infrastructure-failure`, `demo:automation-failure` | `pipeline/test_classification.py::test_error_signatures_map_to_their_class`                             |
| `demo:flaky-test`                                        | `pipeline/test_retries.py`                                                                              |
| `demo:recovered-bug`                                     | `pipeline/test_recovery.py`                                                                             |
| `demo:soc-brute-force`                                   | `soc/test_dedup_and_suppression.py` (redelivery, suppression, one user in two spellings)                |
| `demo:soc-triage`                                        | `soc/test_triage.py`                                                                                    |
| `demo:soc-malware`, `demo:soc-response`                  | `soc/test_response_actions.py`                                                                          |
| `demo:soc-multi-siem`                                    | `soc/test_cross_siem.py`                                                                                |
| `demo:aws-local`, `demo:observability`                   | are pytest: `system/test_aws_local.py`, `system/test_observability.py`                                  |

## Bugs these suites found

Each was reproduced by a failing test first, then fixed; the test now pins the behaviour.

| Bug                                                                                                                              | Pinned by                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The Playwright reporter emitted payloads the webhook contract rejected                                                           | `contract/test_playwright_reporter.py::test_output_satisfies_the_webhook_contract`                      |
| A test that passed on retry (flaky) opened a Jira issue                                                                          | `pipeline/test_retries.py::test_pass_after_retry_is_flaky_and_opens_no_jira_issue`                      |
| A test that failed on every retry was classified as flaky instead of a regression                                                | `pipeline/test_retries.py::test_failure_on_every_retry_is_a_regression_not_flaky`                       |
| "Possibly fixed" was announced on every pass after the threshold, not once                                                       | `pipeline/test_recovery.py::test_consecutive_passes_after_a_tracked_failure_report_possibly_fixed_once` |
| A passing run dropped the failure-history window                                                                                 | `pipeline/test_recovery.py::test_history_keeps_the_last_five_outcomes`                                  |
| The failure-mode sampler and model comparison CLIs crashed on SOC investigations                                                 | `evaluation/test_offline_evaluation_tools.py`                                                           |
| Two instances starting on a fresh database raced on LangGraph's checkpoint schema setup                                          | `agents/test_single_agent.py`, in the coverage job (fresh database, instances started together)         |
| Every dashboard view failed WCAG 2.1 AA colour contrast, and a scroll area was keyboard-unreachable                              | `tests/ui/specs/accessibility.spec.ts`                                                                  |
| The n8n CI workflow classified and called Jira and Slack itself, then also forwarded the run: duplicate issues, no approval gate | `drift/test_n8n_workflows.py`, `system/test_n8n.py` (real n8n in CI)                                    |

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

Configuration: `INGESTION_URL`, `INGESTION_AI_URL`, `INGESTION_SINGLE_AGENT_URL`,
`INGESTION_RAG_URL`, `MOCK_URL`, `OLLAMA_STUB_URL`,
`TEST_DATABASE_URL`, `WEBHOOK_SECRET`, `MCP_SCOPE_SECRET` (defaults match the Compose stack on
localhost).

The test stack runs **four API instances** on one database, each configured for one concern:

| Instance                 | Port  | Configuration                                       | Used by                       |
| ------------------------ | ----- | --------------------------------------------------- | ----------------------------- |
| `ingestion-service`      | :3001 | agents off                                          | deterministic layers          |
| `ingestion-ai`           | :3011 | supervisor graph on the scripted stub, MCP evidence | `agents`, `mcp`               |
| `ingestion-single-agent` | :3012 | single-agent tool-calling graph on the stub         | `agents/test_single_agent.py` |
| `ingestion-rag`          | :3013 | RAG on a fixture corpus with the stub's embeddings  | `agents/test_rag.py`          |

Deterministic tests therefore never depend on model behaviour, and agent tests control it
completely. The stub's embeddings are a hashed bag of words: texts that share words are close,
so retrieval over `fixtures/rag-corpus` is predictable. They test the RAG plumbing (allowlist,
model separation, ranking, failure handling, citations), not semantic quality.

## UI layer (Playwright)

```text
tests/ui/
  pages/      page objects: DashboardPage, CommandCenterPage, ApprovalQueuePage, SocConsolePage,
              InvestigationsPage, ObservabilityPage, KnowledgePage
  support/    api.ts (seeds runs, alerts, investigations and paused approvals through the APIs),
              fixtures.ts
  specs/      navigation, command center, approvals, SOC console, integrations, resilience,
              investigations, observability (+ benchmark), knowledge, accessibility
```

- **Locators**: roles and accessible names first (`getByRole('button', { name: 'Approve & resume' })`);
  `data-testid` only for repeated items (failure rows, approval cards, containment actions).
- **Seeding**: every test creates its own run or alert through the API, so tests run in parallel
  and in any order (also verified with `--workers=4 --repeat-each=2`). Assertions are scoped to
  the test's own data (for example Jira issues by fingerprint label), never global counts.
- **Roles**: `signedInAs('ci_reviewer' | 'soc_responder')` seeds the reviewer token; one spec
  drives the real sign-in form, including an unknown token.
- **Agents**: approvals are produced by scripting the Ollama stub per test
  (`POST /__scenario/scripts` with the test's own ID as the match), so parallel tests never
  consume each other's model replies.
- **Every view is covered**: each of the eight views has at least one spec, including the
  honesty checks: the deterministic benchmark makes no model-quality claim, investigations
  name the stub as their model, and an unavailable API is shown as such (`page.route` faults).
- **Accessibility**: `accessibility.spec.ts` runs axe-core (WCAG 2.1 A and AA) on every view in
  its populated state and on the SOC alert dialog, and fails with the rule and the elements. It
  runs with reduced motion, so colours are measured after the fade-in. Its first run found
  insufficient contrast on all eight views and a scroll area unreachable by keyboard; both
  were fixed in the dashboard.
- **Dogfooding**: the SignalOps reporter is one of the configured reporters; in CI it delivers
  the UI suite's own results to the platform it is testing.
- **Artifacts**: trace, screenshot and video are kept on failure; HTML and JUnit reports are
  uploaded by CI.

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d \
  postgres mock-integrations enrichment-service ollama-stub ingestion-service dashboard
npx playwright install chromium
npm run test:ui
```

For the UI stack, start `ingestion-service` with `AI_ENABLED=true OLLAMA_HOST=http://ollama-stub:11434
OLLAMA_MODEL=demo-stub`, so the approval specs can pause runs for review.
