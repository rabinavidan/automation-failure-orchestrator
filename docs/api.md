# API Reference

## Ingestion Service (port 3001)

### Health Check

```
GET /health
```

Response:

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "database": "connected"
}
```

---

### Ingest Test Run

```
POST /api/runs
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>
```

**Request Body** (WebhookPayload schema):

```json
{
  "schemaVersion": "1.0.0",
  "runId": "uuid",
  "repository": "org/repo",
  "branch": "main",
  "commitSha": "abc123...",
  "environment": "staging",
  "triggeredBy": "github-actions",
  "startedAt": "2024-01-01T00:00:00.000Z",
  "finishedAt": "2024-01-01T00:01:00.000Z",
  "summary": { "total": 10, "passed": 8, "failed": 2, "skipped": 0 },
  "tests": [...]
}
```

**Response 201** (new run):

```json
{
  "runId": "uuid",
  "processed": 10,
  "skipped": 0,
  "failures": [
    {
      "testId": "tests/api/checkout.spec.ts::...",
      "title": "checkout fails",
      "fingerprint": "abc123...",
      "classification": "new_regression",
      "jiraKey": "AUTO-42",
      "slackSent": true
    }
  ]
}
```

**Response 200** (duplicate run):

```json
{
  "runId": "uuid",
  "processed": 0,
  "skipped": 10,
  "failures": [],
  "duplicateRun": true
}
```

**Response 400** (invalid payload):

```json
{
  "error": "Invalid payload",
  "details": { "fieldErrors": { "runId": ["Required"] } }
}
```

---

### List Runs

```
GET /api/runs?limit=20&offset=0
```

---

### Get Run

```
GET /api/runs/:runId
```

---

### List Failures

```
GET /api/failures?limit=20&offset=0&classification=new_regression
```

---

### Get Failure History

```
GET /api/failures/:fingerprint
```

---

### Reclassify Failure

```
POST /api/failures/:fingerprint/reclassify
Content-Type: application/json

{
  "classification": "known_bug",
  "reason": "Confirmed existing ticket AUTO-100"
}
```

---

### Ingest Splunk Alert

Accepts the payload of Splunk's **Webhook** alert action. `result` fields follow the Splunk CIM.

```
POST /api/alerts/splunk
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>

{
  "sid": "scheduler__admin__SplunkEnterpriseSecuritySuite__RMD5a1b2_at_1759500000_123",
  "search_name": "Access - Brute Force Access Behavior Detected - Rule",
  "app": "SplunkEnterpriseSecuritySuite",
  "results_link": "https://splunk.example.com/app/search/@go?sid=...",
  "result": {
    "_time": "1759500000.000",
    "signature": "Brute Force Access Behavior Detected",
    "src": "203.0.113.7",
    "dest": "WS-042.corp.example.com",
    "user": "CORP\\jdoe",
    "count": "57",
    "urgency": "high",
    "annotations.mitre_attack": ["T1110", "T1110.001"]
  }
}
```

Response (`201` for `new`/`suppressed`, `200` for `duplicate_delivery`, `400` invalid payload):

```json
{
  "alertId": "splunk:scheduler__admin__...:3f9c2a1b7d4e",
  "fingerprint": "<64-char sha256>",
  "fingerprintLabel": "security-alert-fingerprint-<12 hex>",
  "status": "new",
  "occurrenceCount": 1,
  "suppressedCount": 0,
  "firstSeenAt": "2025-10-03T14:00:00.000Z",
  "lastSeenAt": "2025-10-03T14:00:00.000Z"
}
```

---

`new` alerts also carry an `enrichment` outcome from the Python enrichment service:

```json
"enrichment": {
  "status": "enriched",
  "summary": { "verdict": "malicious", "maxScore": 100, "malicious": 3, "suspicious": 0,
               "enriched": 3, "skipped": 3, "providerErrors": 0 }
}
```

`status` is `enriched`, `failed` (service down, timeout, or contract violation — the alert is
still ingested), `disabled` (`ENRICHMENT_URL` unset) or `not_applicable` (suppressed or
duplicate deliveries are never enriched). The full per-indicator result is stored in
`security_alerts.enrichment`.

---

New and suppressed alerts also carry a deterministic `triage` decision (see
[`docs/soc-automation-roadmap.md`](soc-automation-roadmap.md#m3--deterministic-soc-triage-done)):

```json
"triage": {
  "disposition": "true_positive",
  "recommendedAction": "escalate",
  "priority": "P1",
  "riskScore": 100,
  "reasons": [
    "Threat intel: ip 203.0.113.9 (abuseipdb 100, virustotal 90) is malicious",
    "severity high (+70)", "threat intel malicious (+20)",
    "late kill-chain tactic: Credential Access (+10)"
  ],
  "mitre": { "tactics": ["Credential Access"], "techniques": ["T1110"], "inferred": true },
  "policyVersion": "2026.10.1"
}
```

---

### Ingest Normalized Alert

Producers that already emit the `SecurityAlert` contract (see `packages/shared-types/src/security.ts`):

```
POST /api/alerts
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>

{
  "schemaVersion": "1.0.0",
  "alertId": "idp-2025-10-03-0001",
  "source": { "vendor": "generic", "product": "idp" },
  "ruleId": "impossible-travel",
  "ruleName": "Impossible travel",
  "title": "Impossible travel for jdoe",
  "severity": "medium",
  "detectedAt": "2025-10-03T14:00:00Z",
  "user": "jdoe",
  "indicators": [{ "type": "ip", "value": "203.0.113.7", "role": "source" }],
  "mitre": { "tactics": ["Initial Access"], "techniques": ["T1078"] }
}
```

---

### List Alerts

```
GET /api/alerts?limit=20&offset=0&status=new&disposition=needs_investigation&priority=P2
```

`disposition`: `false_positive | duplicate | true_positive | benign_true_positive | needs_investigation`;
`priority`: `P1`–`P4`.

---

### Get Triage Policy

```
GET /api/alerts/triage-policy
```

Returns the active policy (`config/soc-triage-policy.json`), its version, and an `error` field if
the file failed validation (in which case an empty, nothing-auto-closed policy is in force).

---

### Get Alert

```
GET /api/alerts/:alertId
```

---

### Get Alert Fingerprint

```
GET /api/alerts/fingerprints/:fingerprint
```

Returns the aggregate (occurrence/suppressed counts, first/last seen, max severity) and the 50 most recent occurrences.

---

## Enrichment Service (port 3003, Python)

### Enrich Indicators

```
POST /enrich
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>

{
  "alertId": "splunk:sid:abc",
  "indicators": [
    { "type": "ip", "value": "203.0.113.7", "role": "source" },
    { "type": "file_hash", "value": "44d88612fea8a8f36de82e1278abb02f" }
  ]
}
```

Returns per-indicator provider results plus a summary. A full example is
[`apps/enrichment-service/contract/enrich-response.example.json`](../apps/enrichment-service/contract/enrich-response.example.json)
(the golden contract file both test suites verify). Interactive OpenAPI docs: `http://localhost:3003/docs`.

### Health

```
GET /health  ->  { "status": "ok", "mode": "mock", "providers": ["abuseipdb", "virustotal", "geoip"] }
```

---

## Mock Integrations (port 3002)

### Jira Endpoints

| Method | Path                                  | Description     |
| ------ | ------------------------------------- | --------------- |
| POST   | `/jira/rest/api/2/issue`              | Create issue    |
| GET    | `/jira/rest/api/2/search?jql=...`     | Search by JQL   |
| GET    | `/jira/rest/api/2/issue/:key`         | Get issue       |
| POST   | `/jira/rest/api/2/issue/:key/comment` | Add comment     |
| GET    | `/jira/issues`                        | View all issues |

### Slack Endpoints

| Method | Path                          | Description       |
| ------ | ----------------------------- | ----------------- |
| POST   | `/slack/services/T00/B00/xxx` | Receive message   |
| GET    | `/slack/messages`             | View all messages |

### Utility

| Method | Path      | Description     |
| ------ | --------- | --------------- |
| GET    | `/health` | Health check    |
| POST   | `/reset`  | Reset all state |
