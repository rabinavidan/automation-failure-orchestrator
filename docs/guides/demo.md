# Demo guide

One guide for showing the platform: a two-minute walkthrough, the CI scenarios one by one, the
SOC walkthrough with the design decisions worth discussing, and how to feed the UI suite's own
results to the platform. No API keys, accounts or GPU are needed. The full design is in the
[platform reference](../reference/platform-reference.md).

## Prepare

```bash
cp .env.example .env
docker compose up --build -d
npm run ollama:stub &   # optional: exercises the agent graphs, clearly labelled STUB
# for real inference instead: run Ollama, `ollama pull qwen3:4b`, set AI_ENABLED=true in .env
curl -s localhost:3001/api/capabilities | jq '.model.backend, .notes'
```

For local development without Docker, run `npm run dev --workspace=apps/mock-integrations`
(port 3002) and `npm run dev --workspace=apps/ingestion-service` (port 3001).

## The two-minute walkthrough

One incident from signal to evidence to controlled action, then the audit.

| Time | Do                                                                                                 | Say                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open http://localhost:4173. Point at the mode strip under the title.                               | "Every screen says what is real. Here the model is the demo stub and Jira/Slack are mocks, and the UI never lets stub output pass as a real investigation."                                               |
| 0:15 | `npm run demo:new-regression`                                                                      | "A CI run posts a failing test. It is fingerprinted (UUIDs and timestamps stripped), checked for an existing Jira issue and classified by a priority-ordered rule chain."                                 |
| 0:35 | Click the failure in **Command center** to open the dossier.                                       | "The agents gathered evidence. This banner says the stub produced it, so it is not evidence of model quality. Below are the graph version, model calls and tokens, and the LangGraph timeline."           |
| 0:55 | `npm run demo:known-bug`                                                                           | "Same failure again: the label matches the open Jira issue, so it is updated, not duplicated. Deterministic code decides; the agent only advises."                                                        |
| 1:10 | `npm run demo:soc-response`, then open **SOC console**                                             | "Second domain. A brute-force alert is enriched by the Python service and triaged as a true positive. The playbook opens a ticket immediately, but the firewall block waits for a human."                 |
| 1:30 | **Approval queue**: sign in with `demo-soc-responder-token-0001`, then go back to the SOC console. | "Approvals are authenticated and role-checked by the server. The audit records my identity, not whatever name a client sends. Four simultaneous approvals produce exactly one execution; CI checks that." |
| 1:45 | **AI observability** → benchmark card                                                              | "Quality is measured, not asserted. This is the deterministic baseline on a 35-case labeled set, and the harness refuses to score a stub. Real-model results are the next run."                           |

Every dashboard view has its own address (`http://localhost:4173/#/soc`, `#/approvals`, ...), so
you can open the right screen directly.

### If asked

- "Is the AI real?" Show the mode strip and `GET /api/capabilities`. With Ollama running it
  reports `real` and the exact model.
- "What can the agent touch?" Read-only MCP evidence tools scoped by a token it never sees
  ([mcp-evidence.md](../reference/mcp-evidence.md)). Writes go through the deterministic executor.
- "What breaks?" [action-semantics.md](../reference/action-semantics.md): external delivery after
  an approval is not exactly-once, and there is no outbox yet.

### Recording status

No video has been recorded. A real-model walkthrough needs a machine with Ollama. Do not record
the stub run as AI inference; if you record it, keep the STUB banner on screen.

## CI scenarios

Each command posts a canned payload to the running stack. Check the outcome in the dashboard,
or directly at http://localhost:3002/jira/issues, http://localhost:3002/slack/messages,
http://localhost:3001/api/runs and http://localhost:3001/api/failures.

| Command                               | Payload                                                                      | Expected outcome                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run demo:new-regression`         | A fresh failure with no history                                              | `201`, `new_regression`: a new Jira issue and a Slack notification                                    |
| `npm run demo:known-bug`              | The same fingerprint twice                                                   | The second run is `known_bug` and comments on the existing issue instead of opening a duplicate       |
| `npm run demo:flaky-test`             | `status: "passed"` with `retry: 1` and the first attempt's error             | `flaky`: Slack only, no Jira action                                                                   |
| `npm run demo:infrastructure-failure` | `ECONNREFUSED` from a database or network outage, across several tests       | `infrastructure` for each: Slack only                                                                 |
| `npm run demo:automation-failure`     | A Playwright `strict mode violation`: a test-code bug, not an app regression | `automation_failure`: Slack only                                                                      |
| `npm run demo:recovered-bug`          | Run after `demo:new-regression`: the linked test passes three times in a row | `possibly_fixed` after the third pass (`RECOVERY_PASS_THRESHOLD`), a Jira comment and a Slack message |
| `npm run demo:duplicate-delivery`     | The same `runId` twice                                                       | First `201`; second `200` with `duplicateRun: true` and no reprocessing                               |

A `failed` result with `retry > 0` failed on every attempt and is classified like any other
failure, not as flaky.

## SOC walkthrough

A ten-minute path for a SOC automation or security engineering conversation.

```bash
npm run demo:soc-triage       # 1. five alerts, five dispositions
npm run demo:soc-multi-siem   # 2. Splunk, Sentinel, Wazuh → same decision
npm run demo:soc-response     # 3. approve a firewall block, roll it back, show the audit trail
open http://localhost:4173/#/soc   # 4. SOC console: KPIs, approval queue, evidence drawer
```

1. **Noise reduction first.** The scanner alert is closed by an allowlist entry that has an owner
   and an expiry date; the repeat is suppressed by its entity fingerprint; the synthetic monitor
   is a known-benign policy match. Point at the automation-rate KPI.
2. **Vendor-agnostic.** Three native payloads become one contract; the same pipeline, playbook
   and ATT&CK mapping apply.
3. **Human authority over containment.** Tickets and Slack ran automatically; the firewall block
   waited. Approve it, show the mock firewall state, roll it back, open the audit trail.
4. **AI as an analyst, not an actor.** Open a true positive: deterministic reasons, intel verdicts
   (internal entities never sent out), the agents' runbook-grounded recommendation, and the
   evaluation result.

### Design decisions to defend

| Question                                                                        | Answer in this codebase                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why not let the LLM decide?                                                     | Dispositions and side effects are deterministic and testable (`triageAlert`, playbooks). Agents add evidence; code sets `requiresHumanApproval` for containment and for any disagreement with triage.                                                               |
| How do you stop hallucinated IOCs reaching a block list?                        | `evaluateSocInvestigation` extracts every IP/hash/URL from agent output and fails on any not present in the alert or enrichment.                                                                                                                                    |
| Prompt injection via alert fields?                                              | Alert fields are declared untrusted in every system prompt; the raw SIEM payload never reaches the model; the model cannot trigger actions.                                                                                                                         |
| What if a SIEM retries a webhook?                                               | `alertId` idempotency + fingerprint suppression; response actions are unique per (alert, playbook, step, target).                                                                                                                                                   |
| What if an approved action is now wrong?                                        | Guards (private/allowlisted IPs, protected hosts) are re-checked at execution; decisions are atomic (409 on repeat); containment is reversible.                                                                                                                     |
| Threat-intel quotas and privacy?                                                | Only `new` alerts are enriched; single-flight TTL cache; private IPs and internal identities are never sent to providers.                                                                                                                                           |
| What breaks first at scale?                                                     | In-process work → solved with SQS + worker + DLQ (M7). Next: per-tenant rate limits, a real SOAR/SIEM write-back (close incidents in Sentinel), SSO-backed reviewer identity and two-person approval for P1 isolation.                                              |
| How would you evaluate a SOAR platform (Torq, XSOAR, Splunk SOAR) against this? | Keep domain decisions in tested code or policy-as-code; use the SOAR for connectors, case management and low-code orchestration (the n8n workflow shows that split). Evaluate on API-first design, versioned playbooks, approval workflows, audit, and testability. |

### Where to look in the code

| Concern             | Path                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Contract            | `packages/shared-types/src/security.ts`                                                                 |
| SIEM adapters       | `apps/ingestion-service/src/services/alert-normalizers/`                                                |
| Dedup / suppression | `apps/ingestion-service/src/services/alert-processor.ts`                                                |
| Enrichment (Python) | `apps/enrichment-service/src/enrichment_service/`                                                       |
| Triage + ATT&CK     | `packages/failure-classifier/src/alert-triage/`, `config/soc-triage-policy.json`                        |
| Agents + evaluation | `apps/ingestion-service/src/services/soc-investigation.ts`, `soc-agent-evaluation.ts`, `docs/runbooks/` |
| Playbooks + guards  | `config/playbooks/`, `services/response-engine.ts`, `services/response-actions.ts`                      |
| SOAR workflow       | `n8n/workflows/soc-alert-workflow.json`                                                                 |
| AWS                 | `infra/terraform/`, `.github/workflows/deploy-aws.yml`                                                  |
| SOC console         | `apps/dashboard/src/views/soc/SocConsole.tsx`                                                           |

## Feeding the UI suite's results to the platform

The Playwright UI suite (`tests/ui`) tests the dashboard. Its reporter
(`@orchestrator/playwright-reporter`) writes the webhook contract and can deliver it to the
orchestrator directly, so the platform triages its own test results:

```bash
npx playwright install chromium
SIGNALOPS_INGEST_URL=http://localhost:3001/api/runs SIGNALOPS_WEBHOOK_SECRET=local-dev-secret \
  npm run test:ui

# The same payload, kept on disk
cat tests/ui/test-results/signalops-results.json
```
