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

## Mock Integrations (port 3002)

### Jira Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jira/rest/api/2/issue` | Create issue |
| GET | `/jira/rest/api/2/search?jql=...` | Search by JQL |
| GET | `/jira/rest/api/2/issue/:key` | Get issue |
| POST | `/jira/rest/api/2/issue/:key/comment` | Add comment |
| GET | `/jira/issues` | View all issues |

### Slack Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/slack/services/T00/B00/xxx` | Receive message |
| GET | `/slack/messages` | View all messages |

### Utility

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/reset` | Reset all state |
