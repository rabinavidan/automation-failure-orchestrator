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

| #   | Milestone                        | Status  | Scope                                                                                                                      |
| --- | -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| M1  | Security alert ingestion         | ✅ Done | `SecurityAlert` contract, Splunk webhook normalizer, `/api/alerts`, entity fingerprinting, idempotency, suppression window |
| M2  | Python enrichment service        | Planned | FastAPI service: IOC enrichment (AbuseIPDB, VirusTotal, GeoIP) with mock mode, caching, pytest/ruff/mypy                   |
| M3  | Deterministic SOC classifier     | Planned | Allowlisted FP → duplicate → known benign → true positive → needs investigation; severity scoring; MITRE ATT&CK mapping    |
| M4  | AI SOC triage agents             | Planned | LangGraph specialists (triage analyst, threat intel, response planner), runbook RAG, security evaluation gates             |
| M5  | Response playbooks + approval    | Planned | YAML playbook engine, mock EDR (isolate host, kill process, block IP), case/ticket creation, rollback, audit               |
| M6  | SOAR / SIEM interoperability     | Planned | n8n security playbook, optional Wazuh profile, Sentinel normalizer, real Splunk adapter                                    |
| M7  | AWS deployment                   | Planned | Terraform: Lambda/Fargate, SQS/EventBridge, RDS, Secrets Manager; GitHub Actions deploy                                    |
| M8  | SOC dashboard + portfolio polish | Planned | Alert queue, MTTT/automation-rate metrics, demo scenarios (phishing, brute force, EDR malware), architecture diagram       |

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
