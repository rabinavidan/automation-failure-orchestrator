# API Reference

## Ingestion service (port 3001): generated OpenAPI

The ingestion service's API is published as **OpenAPI 3.1** in
[`contracts/openapi.json`](../contracts/openapi.json). It is generated from the route registry in
[`packages/shared-types/src/api.ts`](../packages/shared-types/src/api.ts) and its Zod schemas, so
it cannot drift from the code:

- `npm run contracts:export` regenerates it (with the JSON Schemas in `contracts/json-schema`);
  `npm run contracts:check` fails CI when the committed files are stale.
- `tests/backend/drift/test_openapi.py` fails when a route registered in Express is missing from
  the spec, or the spec lists a route the service does not serve, and validates the document.
- `tests/backend/contract/test_api_responses.py` validates live responses against the published
  schemas, which forbid unknown fields.

Open the file in any OpenAPI viewer (for example the Swagger editor or Redocly) to browse it.
Request bodies are published for the ingest endpoints; response schemas for `POST /api/runs`
and the read models the dashboard uses (runs, failures, approvals, knowledge status, observability
summary). Other responses are listed with their status codes; their schemas follow as they are
added to `shared-types`.

### Authentication

| Scheme          | Header                      | Used by                                                                |
| --------------- | --------------------------- | ---------------------------------------------------------------------- |
| Webhook secret  | `x-webhook-secret`          | Ingest endpoints: `POST /api/runs`, `POST /api/alerts[/:vendor]`       |
| Reviewer token  | `Authorization: Bearer ...` | Decisions, reclassification, reindex; the role is in `x-required-role` |
| MCP scope token | `Authorization: Bearer ...` | `POST /mcp`, minted per investigation                                  |

Reviewer identities come from `REVIEWER_TOKENS` (`name:role1+role2:token;...`); a valid token
without the required role gets `403`. Read endpoints need no credentials in this local-first demo.

### Example: ingest a test run

```bash
curl -X POST http://localhost:3001/api/runs \
  -H "content-type: application/json" -H "x-webhook-secret: local-dev-secret" \
  -d @tests/backend/fixtures/example-run.json
```

The payload follows `contracts/json-schema/webhook-payload.schema.json`; the response follows
`processing-result.schema.json` (201 for a new run, 200 with `duplicateRun: true` for a
redelivery).

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
