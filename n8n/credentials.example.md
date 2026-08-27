# n8n Credentials Setup

## Overview

This project uses n8n for workflow orchestration. The workflow connects to mock services by default.
In production, replace mock endpoints with real Jira/Slack credentials.

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
N8N_ENCRYPTION_KEY=your-secure-key-here
N8N_USER=admin
N8N_PASSWORD=your-secure-password
```

## Workflow Configuration

The main workflow (`n8n/workflows/main-workflow.json`) uses these endpoints:

| Service   | Development                                        | Production                           |
| --------- | -------------------------------------------------- | ------------------------------------ |
| Jira      | `http://mock-integrations:3002/jira`               | `https://your-company.atlassian.net` |
| Slack     | `http://mock-integrations:3002/slack/services/...` | Slack Incoming Webhook URL           |
| Ingestion | `http://ingestion-service:3001`                    | Your deployed ingestion service URL  |

## Importing the Workflow

1. Start n8n: `docker compose up n8n`
2. Open n8n UI: `http://localhost:5678`
3. Login with credentials from `.env`
4. Go to Workflows → Import from File
5. Select `n8n/workflows/main-workflow.json`
6. Activate the workflow

## Testing the Webhook

```bash
curl -X POST http://localhost:5678/webhook/test-results \
  -H "Content-Type: application/json" \
  -d @scripts/payloads/new-regression.json
```

## Security Notes

- Never commit real API tokens to the repository
- Use environment variables for all secrets
- The `N8N_ENCRYPTION_KEY` must be kept secret and backed up
- Rotate credentials if compromised
