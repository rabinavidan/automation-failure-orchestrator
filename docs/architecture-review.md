# Architecture review and improvement plan

A software-architecture pass over the whole repository (November 2026): what is redundant, where
the design contradicts its own rules, and an ordered plan to fix it. Every finding cites the
evidence it rests on, measured on `main` at the time of writing.

## Verdict

The core design is sound: deterministic code owns decisions and side effects, agents only advise,
contracts are Zod-first, and every layer has black-box tests (331 tests, 88.6% backend line
coverage). The problems are at the edges, where the same rule exists in more than one place:

| #   | Finding                                                                         | Severity | Effort |
| --- | ------------------------------------------------------------------------------- | -------- | ------ |
| 1   | The n8n CI workflow re-implements the pipeline and bypasses policy and approval | High     | S      |
| 2   | The CI action policy is written twice inside `run-processor.ts`                 | High     | M      |
| 3   | Configuration is read ad hoc: 31 variables, 63 reads, 25 files, no validation   | Medium   | M      |
| 4   | API response types are declared three times; `AgentInvestigation` has no schema | Medium   | M      |
| 5   | Hand-written API docs have drifted from the routes                              | Medium   | S      |
| 6   | 1,830 lines of offline tooling live in the production service and image         | Medium   | M      |
| 7   | The dashboard is one 1,508-line component that fetches everything on refresh    | Low      | L      |
| 8   | Documentation overlaps and mixes reference, guides and history                  | Low      | S      |
| 9   | Dead code and unused dependencies                                               | Low      | XS     |

Effort: XS < 1 h, S < half a day, M about a day, L several days.

## Findings

### 1. The n8n CI workflow is a second pipeline that bypasses policy

**Evidence.** `n8n/workflows/main-workflow.json` contains its own `Generate Fingerprint` (41 lines
of JavaScript), `Classify Failure` (48 lines) and `Route by Classification`, then calls Jira and
Slack directly (`Create Jira Issue`, `Add Jira Comment`, `Send Slack Notification`). The API
path decides the same things in `fingerprint-engine`, `failure-classifier` and
`run-processor.ts`.

**Why it matters.** It breaks the platform's central rule that deterministic, tested code owns
every side effect. Runs that arrive through n8n skip the flaky and recovery history, the
`human_review` approval gate, idempotency on `runId` and the audit trail. The drift test
(`tests/backend/drift/test_n8n_workflows.py`) catches a classification mismatch, but only for the
cases it samples, and it cannot make the bypass safe.

**Plan.** Make the CI workflow a thin front door, like the SOC workflow already is: receive,
forward to `POST /api/runs`, return the API's response. Delete the fingerprint, classification
and Jira/Slack nodes. Extend the drift test to assert the workflow has no Jira or Slack node and
no code node that computes a fingerprint or class.

**Proof.** The drift test fails on today's workflow and passes after the change; a pipeline test
posts through n8n and asserts the same decision and actions as a direct `POST /api/runs`.

### 2. The CI action policy is duplicated inside the service

**Evidence.** `run-processor.ts` decides "which side effects for which class" twice: in the
`switch` inside `processTest` (from line 248) and again in `executeApprovedFailureActions`
(from line 553), which runs after a human approves. Both call `handleNewRegression`,
`handleKnownBug` and `sendSlackNotification` with hand-copied arguments. The SOC track already
solves this properly: playbooks are planned as data, and `response-engine.ts` executes the plan
both immediately and after approval.

**Why it matters.** A change to the CI policy (for example, notifying on infrastructure failures)
must be made in two places; forgetting one makes approved and auto-approved runs behave
differently, which the tests only catch for the classes they cover.

**Plan.** Introduce `planFailureActions(classification, context): FailureAction[]` (pure,
deterministic) and one executor. `processTest` either executes the plan or stores it with the
approval; approval executes the stored plan. `run-processor.ts` shrinks to orchestration.

**Proof.** Existing pipeline and approval tests stay green unchanged; add one parametrised
pytest that asserts the actions per class are identical with and without approval.

### 3. No central, validated configuration

**Evidence.** 63 `process.env` reads of 31 distinct variables across 25 files.
`OLLAMA_HOST ?? 'http://localhost:11434'` alone appears in 6 files. Nothing validates
configuration at startup, so a typo such as `AI_ENABLED=ture` silently disables agents.
`runtime-capabilities.ts` reconstructs the same values a third time for `/api/capabilities`.

**Plan.** One `config.ts` that parses `process.env` once with a Zod schema, fails fast with a
readable error, and exports a typed, frozen object. Services take what they need from it;
`/api/capabilities` reports from it. `.env.example` is checked against the schema by a drift
test, so a new variable cannot be undocumented.

**Proof.** A pytest starts the API with an invalid value and asserts it refuses to start with a
message naming the variable.

### 4. API response types live in three places

**Evidence.** `packages/shared-types` validates the inbound contracts with Zod, but responses are
plain interfaces (`AgentInvestigation`, `FailureSummary`, `ProcessingResult`, and more). The
dashboard then re-declares its own copies (`App.tsx` lines 36 to 200: `AgentInvestigation`,
`Failure`, `Run`, `ApprovalRequest`, `ObservabilitySummary` and 7 more) instead of importing
them. Three copies of one shape drift independently; the UI tests are currently the only thing
that would notice.

**Plan.** Define response schemas in `shared-types` with Zod (`AgentInvestigationSchema`,
`FailureSchema`, and the read models), derive the TypeScript types with `z.infer`, validate agent
output against `AgentInvestigationSchema`, export them to JSON Schema like the inbound contracts,
and have the dashboard import the types.

**Proof.** The pytest contract layer validates every read-model response against the exported
schema (the same mechanism already used for inbound payloads).

### 5. Hand-written API documentation has drifted

**Evidence.** `docs/api.md` (464 lines) documents none of `/api/approvals`, `/api/knowledge/*`,
`/api/benchmark/summary`, `/api/observability/summary`, `/api/alerts/metrics` or the MCP endpoint,
all of which exist in `src/routes`. `docs/platform-reference.md` repeats part of the API surface
and misses `/api/responses` and `/api/approvals`.

**Plan.** Generate an OpenAPI document from the Zod schemas of finding 4
(`@asteasolutions/zod-to-openapi`), publish it with the contracts, and add a drift test that every
registered route appears in it. Replace `api.md` with a short page linking to the generated spec.

### 6. Offline tooling inside the production service

**Evidence.** About 1,830 lines (20% of `apps/ingestion-service/src`) are never imported by the
server: `src/benchmark/*`, `src/scripts/*`, and the services only those scripts use
(`agent-judge`, `failure-mode-taxonomy`, `execution-fetcher`, `version-comparison`). They compile
into `dist/` and ship in the production image. The Ollama client is also constructed separately
in 4 places (the agent and three scripts).

**Plan.** Move them to a `packages/evaluation` workspace that depends on the service's public
modules; the image builds only the server and the worker. Add one model-client factory used by
the agents and the tools.

**Proof.** The evaluation pytest layer runs the CLIs from their new location unchanged; the image
no longer contains `dist/benchmark` or `dist/scripts` (checked by the container smoke job).

### 7. The dashboard is a monolith

**Evidence.** `App.tsx` is 1,508 lines with 14 `useState` hooks, one per concern, and a single
`loadData` that fetches 7 endpoints on every refresh, including views the user is not looking at.
There is no routing, so a view cannot be linked or bookmarked.

**Plan.** Split into one folder per view (component, data hook, types from `shared-types`), fetch
per view, and add URL routing. The Playwright page objects already follow these view boundaries,
so the 36 UI tests are the safety net for the refactor.

### 8. Documentation sprawl

**Evidence.** 15 top-level documents. `architecture.md` overlaps `platform-reference.md`;
`demo-scenarios.md`, `demo-two-minute.md` and `soc-interview-guide.md` overlap each other;
`release-notes-rc1.md`, `flagship-progress.md` and `flagship-baseline.md` are history and status
mixed with reference.

**Plan.** Three folders: `docs/reference` (platform reference, generated API, action semantics,
MCP, observability), `docs/guides` (one demo guide, Shuffle lab, runbooks) and `docs/history`
(release notes, progress, baseline). Merge `architecture.md` into `platform-reference.md` and the
three demo documents into one.

### 9. Dead code and unused dependencies

- `services/judge-labeled-set.ts` (88 lines) is imported by nothing; its only consumer was a unit
  test removed with vitest.
- `@opentelemetry/context-async-hooks` and `@opentelemetry/sdk-trace-base` (ingestion-service
  devDependencies) are used only by a deleted unit test.
- `p-retry@7.1.1` is installed where `@llamaindex/workflow-core` declares `^6.2.1`
  (`npm ls` reports it invalid).

## What is not redundant

Some things look duplicated but carry their own weight; this review recommends keeping them:

- **n8n and Shuffle.** Both are thin SOAR front doors once finding 1 is fixed; they demonstrate
  that orchestration tools stay replaceable because no decision lives in them.
- **Single-agent and multi-agent graphs.** They are the two configurations the benchmark compares;
  removing one removes the experiment.
- **Direct and MCP evidence transport.** MCP is the security boundary under test; direct access is
  the fallback when it is off.
- **Four API instances in the test stack.** Each isolates one configuration, so deterministic
  tests never depend on model behaviour.
- **Azure Pipelines.** It duplicates GitHub Actions on purpose and is drift-tested; it has never
  run in Azure DevOps. Keep it only while Azure DevOps experience matters for the roles targeted.

## Roadmap

One pull request per step, each merged on green CI. The order removes risk first and makes later
steps cheaper.

| Step | Change                                                     | Findings | Proven by                                     | Status |
| ---- | ---------------------------------------------------------- | -------- | --------------------------------------------- | ------ |
| 1    | Remove dead code and unused dependencies                   | 9        | build, `npm ls`, existing suites              | done   |
| 2    | n8n CI workflow becomes a thin front door                  | 1        | drift test (fails before, passes after)       | done   |
| 3    | One action plan and executor for the CI track              | 2        | approval-parity pytest                        | done   |
| 4    | Central Zod-validated configuration                        | 3        | invalid-config pytest, `.env.example` drift   | done   |
| 5    | Response schemas in `shared-types`; dashboard imports them | 4        | read-model contract tests                     | done   |
| 6    | Generated OpenAPI; retire `api.md`                         | 5        | route-coverage drift test                     | done   |
| 7    | `packages/evaluation` workspace; one model-client factory  | 6        | evaluation layer unchanged; image smoke check | to do  |
| 8    | Dashboard split per view with routing                      | 7        | the 36 Playwright tests unchanged             | to do  |
| 9    | Documentation restructure                                  | 8        | link check                                    | to do  |

Steps 5 and 6 together: the agent investigation, the `POST /api/runs` response and the five read
models the dashboard uses have Zod schemas, the dashboard imports them, and all 29 routes are in
the generated OpenAPI spec. Responses of the remaining GET endpoints (alerts, response actions,
run and failure detail) are listed with their status codes; their schemas are future work.

Expected effect: about 2,000 lines leave the production service, the CI policy and configuration
each have one source of truth, the n8n bypass of the approval gate closes, and the API contract
is generated instead of hand-maintained.
