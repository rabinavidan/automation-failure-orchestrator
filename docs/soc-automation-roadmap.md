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
| M2  | Python enrichment service        | ✅ Done | FastAPI service: IOC enrichment (AbuseIPDB, VirusTotal, GeoIP) with mock mode, caching, pytest/ruff/mypy                   |
| M3  | Deterministic SOC classifier     | ✅ Done | Allowlisted FP → duplicate → known benign → true positive → needs investigation; severity scoring; MITRE ATT&CK mapping    |
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
