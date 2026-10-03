# SOC Automation Track — Roadmap

The same guarded pipeline that triages CI failures (validate → fingerprint → classify →
investigate → policy → act) is being extended to **security alerts**: SIEM detections are
ingested, deduplicated, enriched, triaged by deterministic rules plus advisory AI agents,
and answered with human-approved response playbooks.

Design principles carried over from the CI track:

- **Contract-first**: vendor payloads are normalized into one Zod `SecurityAlert` contract.
- **Deterministic rules own side effects**: the LLM advises; containment always passes a policy gate.
- **Human-in-the-loop for high-risk actions**: host isolation, account disable, and IP blocks require approval.
- **Idempotent, auditable, local-first**: every action is replay-safe, recorded, and runnable with mocks.

## Milestones

| #   | Milestone                        | Status  | Scope                                                                                                                                       |
| --- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Security alert ingestion         | ✅ Done | `SecurityAlert` contract, Splunk webhook normalizer, `/api/alerts`, entity fingerprinting, idempotency, suppression window                  |
| M2  | Python enrichment service        | ✅ Done | FastAPI service: IOC enrichment (AbuseIPDB, VirusTotal, GeoIP) with mock mode, caching, pytest/ruff/mypy                                    |
| M3  | Deterministic SOC classifier     | ✅ Done | Allowlisted FP → duplicate → known benign → true positive → needs investigation; severity scoring; MITRE ATT&CK mapping                     |
| M4  | AI SOC triage agents             | ✅ Done | LangGraph specialists (triage analyst, threat intel, response planner), runbook RAG, security evaluation gates                              |
| M5  | Response playbooks + approval    | ✅ Done | YAML playbook engine, mock EDR (isolate host, kill process, block IP), case/ticket creation, rollback, audit                                |
| M6  | SOAR / SIEM interoperability     | ✅ Done | Sentinel + Wazuh normalizers beside Splunk (vendor registry), multi-SIEM n8n SOC workflow with ChatOps approval requests                    |
| M7  | AWS deployment                   | ✅ Done | Terraform (ECS Fargate, RDS, SQS + DLQ worker, WAF, KMS, Secrets Manager, GitHub OIDC), Checkov-gated in CI, approval-gated deploy workflow |
| M8  | SOC dashboard + portfolio polish | Planned | Alert queue, MTTT/automation-rate metrics, demo scenarios (phishing, brute force, EDR malware), architecture diagram                        |

## M1 — Security alert ingestion (done)

**Flow**

```text
Splunk webhook alert action ──► POST /api/alerts/splunk ──► normalizeSplunkAlert() ──┐
Normalized producer ──────────► POST /api/alerts ─────────────────────────────────────┤
                                                                                      ▼
                                          SecurityAlertSchema (Zod) validation
                                                                                      ▼
                     alertId idempotency ──► entity fingerprint ──► suppression window
                                                                                      ▼
                                  security_alerts (per delivery) + alert_fingerprints (aggregate)
```

**Splunk normalization** maps Splunk CIM fields onto the contract:

| Splunk field(s)                                                  | Normalized                                      |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| `search_name`                                                    | `ruleName` / `ruleId` (unless `rule_id`)        |
| `signature`, `rule_title`                                        | `title`                                         |
| `urgency`, `severity` (string or 1–6 numeric)                    | `severity`                                      |
| `_time` (epoch or ISO)                                           | `detectedAt`                                    |
| `src`, `src_ip`, `dest`, `dest_ip`                               | `ip` / `host` indicators, routed by value shape |
| `user`, `src_user`, `dest_user`                                  | `user` + `user` indicators                      |
| `file_hash`, `sha256`, `sha1`, `md5`                             | `file_hash` indicators                          |
| `url`, `domain`, `query`, `process`, `sender`, ...               | matching indicators                             |
| `annotations.mitre_attack`, `mitre_technique_id`, `mitre_tactic` | `mitre.techniques` / `mitre.tactics`            |

**Identity** — `SHA256(vendor | ruleId | host | user | sorted indicators)` after normalizing
hosts (`WS-042.corp.example.com` → `ws-042`) and users (`CORP\jdoe`, `jdoe@corp.example.com` →
`jdoe`). Timestamps, `sid`, counts, and raw payload are excluded, so repeated firings of the
same detection on the same entities collapse onto one fingerprint.

**Outcomes**

| Status               | Meaning                                                                      | HTTP |
| -------------------- | ---------------------------------------------------------------------------- | ---- |
| `new`                | First sighting, or outside `ALERT_SUPPRESSION_WINDOW_MINUTES` — actionable   | 201  |
| `suppressed`         | Same fingerprint seen within the window — recorded and counted, not actioned | 201  |
| `duplicate_delivery` | Same `alertId` already ingested (webhook retry) — no-op                      | 200  |

Concurrency: the fingerprint aggregate row is inserted-then-locked (`SELECT ... FOR UPDATE`)
and `alert_id` is unique, so parallel retries produce exactly one `new` and the rest
`duplicate_delivery` (verified with 5 concurrent deliveries against PostgreSQL).

**Try it**

```bash
docker compose up --build -d
npm run demo:soc-brute-force
curl 'http://localhost:3001/api/alerts?status=suppressed'
```

## M2 — Python enrichment service (done)

`apps/enrichment-service` is a FastAPI service (Python 3.12, pydantic v2, httpx) that
enriches alert indicators with threat intel. The ingestion service calls it for every
**new** alert after the ingestion transaction commits.

```text
POST /api/alerts/splunk ─► dedup/suppression ─► status = new? ─► POST enrichment-service /enrich
                                                    │                    │
                                                    │ suppressed /       ├─ AbuseIPDB  (IP reputation)
                                                    │ duplicate:         ├─ VirusTotal (IP, domain, URL, hash)
                                                    │ no lookup, no quota└─ ipinfo    (geo / ASN context)
                                                    ▼
                         security_alerts.enrichment (JSONB) + enrichment_verdict
```

| Concern         | Behaviour                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Data protection | Private/loopback/link-local IPs and internal identities (user, host, process, email) are never sent out         |
| IOC hygiene     | Refangs `hxxp://evil[.]com`, validates domains/URLs, detects MD5/SHA-1/SHA-256                                  |
| Rate limits     | Per-provider TTL cache with single-flight: concurrent identical lookups share one upstream call                 |
| Resilience      | Per-provider timeout; a failing provider yields `unknown` + `error`, never fails the request                    |
| Fail-open       | If the service is down or violates the contract, the alert is still ingested (`enrichment.status=failed`)       |
| Secret hygiene  | Exception text (which may contain URLs/keys) is never returned to callers                                       |
| Verdict         | Most severe provider verdict wins: unknown < benign < suspicious < malicious                                    |
| Modes           | `ENRICHMENT_MODE=mock` (default, deterministic offline intel) or `live` (real APIs, keys from env)              |
| Contract        | Golden `contract/enrich-response.example.json` is asserted by pytest **and** parsed by the TS Zod schema        |
| Quality gates   | ruff (incl. bandit `S` rules), ruff format, mypy `--strict`, pytest (respx-mocked HTTP) in CI; Trivy image scan |

```bash
npm run demo:soc-malware     # C2 IP + EICAR hash + defanged URL -> malicious; internal IP/host/user skipped
npm run test:python          # ruff + mypy + pytest (needs the service venv: pip install -e '.[dev]')
```

## M3 — Deterministic SOC triage (done)

Every `new` or `suppressed` alert gets an explainable triage decision from
`triageAlert()` in `packages/failure-classifier/src/alert-triage/`. The decision is
persisted on `security_alerts` (migration 011) and returned by the ingestion API. As in
the CI track, rules decide; the LLM agents (M4) will only add evidence.

**Priority chain (first match wins)**

| #   | Disposition            | When                                                                                                              | Action        |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | `false_positive`       | Allowlist policy match (e.g. our own vulnerability scanner, an authorized red team)                               | `close`       |
| 2   | `duplicate`            | Fingerprint suppressed within the dedup window                                                                    | `suppress`    |
| 3   | `true_positive`        | Any indicator enriched as **malicious**, or a **critical** high-confidence ATT&CK technique (T1003, T1486, T1490) | `escalate`    |
| 4   | `benign_true_positive` | Known-benign policy match (sanctioned activity, e.g. a synthetic login monitor)                                   | `close`       |
| 5   | `needs_investigation`  | Everything else, ranked by risk score                                                                             | `investigate` |

Malicious intel deliberately outranks known-benign policy: a sanctioned service account
talking to a known-bad IP is escalated, not closed.

**Risk score (0–100) and priority**

`severity base (info 10 / low 25 / medium 50 / high 70 / critical 90)` + `malicious intel +20`
or `suspicious +10` + `late kill-chain tactic +10` (Credential Access, Lateral Movement,
C2, Exfiltration, Impact) + `recurrence +5 (≥5) / +10 (≥20)`, capped at 100.
P1 ≥ 85, P2 ≥ 65, P3 ≥ 40, else P4. True positives are never ranked below P2.

**MITRE ATT&CK**: SIEM-supplied techniques are kept and mapped to tactics; when a rule has
no annotation, a technique is inferred from the rule name (`inferred: true`), e.g.
"Brute Force" → T1110 / Credential Access, "Ransomware" → T1486 / Impact.

**Policy-as-code** (`config/soc-triage-policy.json`, Zod-validated):

- Every entry needs an `id`, `description`, `owner` and **`expiresAt`**: allowlists must be
  reviewed and renewed; expired entries silently stop matching.
- Match criteria are ANDed: `ruleId` (wildcards), `host`, `user` (identity-normalized),
  `indicator` (IPv4 CIDR for IPs).
- **Fail-safe**: an invalid or missing policy file falls back to an empty policy, so nothing is
  auto-closed. `GET /api/alerts/triage-policy` shows the active version and any load error.

```bash
npm run demo:soc-triage   # one alert per disposition
curl 'http://localhost:3001/api/alerts?disposition=needs_investigation&priority=P2'
```

## M4 — Advisory SOC agents (done)

`services/soc-investigation.ts` is a LangGraph supervisor (`soc-supervisor-v1`) over three
specialists. It runs only for `true_positive` and `needs_investigation` alerts, after the
webhook response (in-process; a durable queue arrives with the AWS milestone), and persists to
`security_alerts.ai_investigation` / `ai_evaluation` (migration 012). Executions, graph events,
and per-call model telemetry share the CI track's audit tables, so
`GET /api/observability/summary` covers both tracks.

```text
triage_analyst ─► threat_intel ─► response_planner ─► supervisor ─► guardrails (code)
 alert + triage    enrichment only    selected runbooks    reconcile      approval / conflict flags
```

| Safety property             | How it is enforced                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Triage is authoritative     | The disposition is never changed; disagreement sets `conflictsWithTriage` + `requiresHumanApproval` |
| No autonomous containment   | `contain` or a high-risk plan always sets `requiresHumanApproval` (code, not prompt)                |
| Prompt-injection resistance | Alert fields are declared untrusted in every system prompt; the raw SIEM payload is never sent      |
| Grounded responses          | Runbooks selected deterministically by ATT&CK technique (`docs/runbooks/`); citations are verified  |
| No hallucinated IOCs        | Evaluation extracts every IP/hash/URL from the output and fails on any not in the alert/enrichment  |
| Fail-open                   | Model down, timeout, or schema-invalid output → `ai_investigation_status = failed`; triage stands   |
| Cost control                | No model calls for false positives, duplicates, or known-benign alerts                              |

The evaluation gate (`soc-agent-evaluation.ts`) is deterministic code, part of
`npm run test:evaluations`, and its result is stored with every investigation.

## M5 — Response playbooks with approval and rollback (done)

Deterministic **YAML playbooks** (`config/playbooks/*.yaml`, Zod-validated) turn a triage
decision into response actions. The engine (`services/response-engine.ts`) runs for `new`
alerts after triage; the AI investigation never triggers actions.

```text
triage (true_positive / needs_investigation)
   └─► matching playbooks (disposition + ATT&CK technique + max priority)
         ├─ ticket.create / slack.notify          ─► run immediately (fingerprint-correlated ticket)
         └─ firewall.block_ip / edr.isolate_host
            / edr.kill_process                    ─► blast-radius guard ─► pending_approval
                                                        │
                       POST /api/responses/actions/:id/decision (human) ─► guard re-check ─► execute
                       POST /api/responses/actions/:id/rollback (human) ─► unblock / release host
```

| Playbook               | Trigger                                 | Steps (approval)                                                   |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `brute-force-response` | true_positive + T1110                   | ticket, Slack, **block source IP**                                 |
| `malware-containment`  | true_positive + T1204/T1059/T1105/T1071 | ticket, Slack, **kill process**, **isolate host**, **block C2 IP** |
| `critical-compromise`  | true_positive + T1003/T1486/T1490       | ticket, Slack, **isolate host**                                    |
| `analyst-queue`        | needs_investigation, P1–P2              | ticket, Slack                                                      |

| Safety property                | Enforcement                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No autonomous containment      | Schema rejects any playbook whose containment step is not `approval: required`                                                                 |
| Allowlisted actions only       | Actions are an enum; unknown actions (e.g. `shell.exec`) fail validation; invalid files never load                                             |
| Blast-radius guards            | Never block private/loopback/link-local/multicast IPs or triage-allowlisted IPs; never isolate `SOC_PROTECTED_HOSTS` (e.g. domain controllers) |
| Guards re-checked at execution | An approval cannot execute against a target allowlisted after the approval was requested                                                       |
| Exactly-once decisions         | Atomic `UPDATE ... WHERE status = 'pending_approval'`; a second approval returns 409                                                           |
| Idempotent planning            | Unique `(alert, playbook, step, target)`; webhook re-delivery never duplicates actions                                                         |
| Reversible containment         | Block → unblock, isolate → release; a failed rollback restores the action's state for retry                                                    |
| Audit                          | Append-only `response_action_events`: planned, approved/rejected, executed, blocked, rolled back, with actor                                   |

Mock EDR and firewall APIs live in `apps/mock-integrations` (`/edr/*`, `/firewall/*`), so the
full loop runs locally and in the CI smoke test (approve → execute → rollback).

```bash
npm run demo:soc-response
curl 'http://localhost:3001/api/responses/actions?status=pending_approval'
```

Known limitation: reviewer identity is a free-text field (as in the CI approval flow);
production needs SSO-backed identity and role-based approval (e.g. two-person rule for P1 isolation).

## M6 — Multi-SIEM interoperability and n8n SOAR front door (done)

**SIEM adapters** (`services/alert-normalizers/`, one registry entry each, `POST /api/alerts/:vendor`):

| Vendor             | Native payload                                           | Notable mapping                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Splunk             | Webhook alert action (`sid`, `search_name`, `result`)    | CIM fields; ambiguous `src`/`dest` routed by IP vs hostname                                                                                                                                          |
| Microsoft Sentinel | Logic App alert (`SystemAlertId`, `Entities`, `Tactics`) | `Entities` as array or JSON string; account/host/ip/file/url/process/dns/mailbox entities; `CredentialAccess` → `Credential Access`; IP role inferred from address space (Sentinel has no direction) |
| Wazuh              | Integration alert (`rule.level`, `rule.mitre`, `data`)   | Rule level 0–15 → severity; ATT&CK straight from `rule.mitre`                                                                                                                                        |

Every adapter's output is re-validated against `SecurityAlertSchema`, so a vendor parsing bug
fails at the edge (422) instead of polluting the pipeline. Fingerprints stay vendor-scoped. A
test proves the same brute-force pattern from all three SIEMs reaches the same triage decision.

**n8n SOC workflow** (`n8n/workflows/soc-alert-workflow.json`, webhook `/webhook/soc-alerts`):

```text
Receive SIEM Alert ─► Detect SIEM Vendor ─► Ingest via Orchestrator ─► Route by Triage Disposition
                     (payload shape)        (POST /api/alerts/:vendor)   ├─ true_positive ─► Summarize Pending Containment ─► Request Approval in Slack ─┐
                                                                         ├─ needs_investigation ──────────────────────────────────────────────────────────┤
                                                                         └─ other ─────────────────────────────────────────────────────────────────────────┴─► Respond to SIEM
```

The workflow is the low-code orchestration layer a SOAR team would edit (fan-in from several
SIEMs, ChatOps approval requests), while every domain decision (dedup, enrichment, triage,
playbooks, approvals) stays in the tested service. Unlike the CI workflow, it duplicates no
rule logic; a test enforces that no triage/policy logic appears in its Code nodes and executes
those nodes against the real vendor fixtures. `scripts/setup-n8n.sh` now imports and activates
every workflow in `n8n/workflows/`.

```bash
npm run demo:soc-multi-siem            # Splunk, Sentinel and Wazuh -> same triage + playbook
N8N=true npm run demo:soc-multi-siem   # same, through the n8n SOC workflow
```

Deferred: live Splunk/Sentinel API adapters (pulling notables, closing incidents back in the
SIEM) and a Wazuh container profile. The normalizers already accept their native payloads.

## M7 — AWS deployment (done)

`infra/terraform` provisions the platform on AWS (see its [README](../infra/terraform/README.md)
for the architecture, security controls, deploy steps and cost):

- **Compute**: ECS Fargate services for the API, the Python enrichment service, the new
  **SQS investigation worker**, and (demo) the mock integrations, in private subnets.
- **Durable AI queue**: with `INVESTIGATION_QUEUE=sqs` the API only enqueues the alert id;
  `dist/workers/investigation-worker.js` consumes it with at-least-once semantics (delete only
  after the result is persisted, idempotent on redelivery, poison messages discarded, failures
  backed off and dead-lettered after 3 attempts with a CloudWatch alarm). This removes the M4
  limitation that a restart lost queued investigations.
- **Data**: RDS PostgreSQL 16 with forced TLS (the app verifies the RDS CA via `DB_SSL=require`)
  and an RDS-managed password injected as `PGUSER`/`PGPASSWORD` from Secrets Manager.
- **Edge**: ALB + AWS WAF (rate limiting and managed rule groups) restricted to SIEM egress CIDRs;
  HTTPS required unless explicitly opted out for a demo.
- **Delivery**: GitHub OIDC (no AWS keys in GitHub) and a manual, environment-approved
  `Deploy to AWS` workflow that pushes immutable images and rolls services with circuit-breaker
  rollback. CI runs `terraform validate` plus a **Checkov** IaC scan (309 passed, 0 failed,
  13 documented skips).

Not applied from this repository's CI: provisioning creates billable resources in the
operator's AWS account and is run deliberately with `terraform apply`.
