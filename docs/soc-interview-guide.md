# SOC Automation — Interview Walkthrough

A 10-minute path through the project for a SOC automation / security engineering interview,
and the design decisions worth discussing.

## Demo script (≈ 6 minutes)

```bash
docker compose up --build -d
npm run demo:soc-triage       # 1. five alerts, five dispositions
npm run demo:soc-multi-siem   # 2. Splunk, Sentinel, Wazuh → same decision
npm run demo:soc-response     # 3. approve a firewall block, roll it back, show the audit trail
open http://localhost:4173    # 4. SOC console: KPIs, approval queue, evidence drawer
```

1. **Noise reduction first.** The scanner alert is closed by an allowlist entry that has an owner
   and an expiry date; the repeat is suppressed by its entity fingerprint; the synthetic
   monitor is a known-benign policy match. Point at the automation-rate KPI.
2. **Vendor-agnostic.** Three native payloads become one contract; the same pipeline, playbook
   and ATT&CK mapping apply.
3. **Human authority over containment.** Tickets and Slack ran automatically; the firewall
   block waited. Approve it, show the mock firewall state, roll it back, open the audit trail.
4. **AI as an analyst, not an actor.** Open a true positive: deterministic reasons, intel
   verdicts (internal entities never sent out), the agents' runbook-grounded recommendation, and
   the evaluation result.

## Design decisions to defend

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

## Where to look in the code

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
| SOC console         | `apps/dashboard/src/SocConsole.tsx`                                                                     |
