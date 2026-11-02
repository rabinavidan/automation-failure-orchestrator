# Demo Scenarios

## Prerequisites

```bash
# Start all services
docker compose up -d

# Or start individual services for local dev:
npm run dev --workspace=apps/mock-integrations  # port 3002
npm run dev --workspace=apps/ingestion-service  # port 3001
```

## Scenario 1: New Regression

A fresh failure with no prior history. Creates a new Jira issue and sends Slack notification.

```bash
npm run demo:new-regression
```

**Expected behavior:**

- `POST /api/runs` returns `201` with `classification: "new_regression"`
- Mock Jira shows a new issue at `http://localhost:3002/jira/issues`
- Mock Slack shows a notification at `http://localhost:3002/slack/messages`

---

## Scenario 2: Known Bug

The same fingerprint sent twice. Second occurrence is identified as a known bug.

```bash
npm run demo:known-bug
```

**Expected behavior:**

- First run: creates Jira issue
- Second run: `classification: "known_bug"`, adds a comment to existing issue

---

## Scenario 3: Flaky Test

A test that failed, then passed on retry: `status: "passed"` with `retry: 1` and the first attempt's error. (A `failed` result with `retry > 0` failed on every attempt and is classified like any other failure.)

```bash
npm run demo:flaky-test
```

**Expected behavior:**

- `classification: "flaky"`
- Slack notification only (no Jira action)

---

## Scenario 4: Infrastructure Failure

`ECONNREFUSED` error indicating database/network is down.

```bash
npm run demo:infrastructure-failure
```

**Expected behavior:**

- `classification: "infrastructure"`
- Slack notification only
- Multiple tests with same infra error all classified correctly

---

## Scenario 5: Automation Failure

`strict mode violation` in Playwright — test code bug, not app regression.

```bash
npm run demo:automation-failure
```

**Expected behavior:**

- `classification: "automation_failure"`
- Slack notification only

---

## Scenario 6: Recovered Bug

A test that previously had a Jira issue now passes 3 consecutive times.

```bash
# First, create a known bug
npm run demo:new-regression

# Then simulate recovery
npm run demo:recovered-bug
```

**Expected behavior:**

- After 3 consecutive passes: `classification: "possibly_fixed"`
- Jira comment added noting potential fix
- Slack notification

---

## Scenario 7: Duplicate Delivery

Same `runId` sent twice — idempotency check.

```bash
npm run demo:duplicate-delivery
```

**Expected behavior:**

- First request: `201` processed normally
- Second request: `200` with `duplicateRun: true`, no reprocessing

---

## Viewing Results

After running demos, check:

- **Mock Jira issues**: http://localhost:3002/jira/issues
- **Mock Slack messages**: http://localhost:3002/slack/messages
- **Run history**: http://localhost:3001/api/runs
- **Failure history**: http://localhost:3001/api/failures

## Running the UI tests and feeding their results to the platform

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
