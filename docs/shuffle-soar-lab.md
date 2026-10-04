# Shuffle SOAR Lab — hands-on, zero cost

A self-paced lab to build real experience with a SOAR platform: [Shuffle](https://github.com/Shuffle/Shuffle),
an open-source SOAR, self-hosted in Docker next to this project's orchestrator. Everything runs
locally; no accounts, licences or cloud costs.

The concepts carry over to commercial SOAR platforms (Torq, Cortex XSOAR, Splunk SOAR, Tines):
triggers, apps/integrations, actions, data references between steps, conditions, and
execution history. After the lab you can honestly say you have built and operated SOAR
workflows in Shuffle. Do not claim production experience on platforms you have not used.

## 0. Start the stack (~10 minutes the first time)

```bash
docker compose -f docker-compose.yml -f docker-compose.shuffle.yml up --build -d
npm run shuffle:setup     # waits for Shuffle to download its apps, then imports the playbook
npm run shuffle:run       # runs the playbook once with a Splunk alert
```

Open <http://localhost:3080> and log in as `admin@orchestrator.local` / `ShuffleLab123!`.
Shuffle needs about 4 GB of free RAM (OpenSearch). Stop it with
`docker compose -f docker-compose.yml -f docker-compose.shuffle.yml down`.

## 1. Read the imported playbook

Open **Workflows → SOC Alert Triage (Orchestrator)**.

| Node     | App / action        | What it does                                                                          |
| -------- | ------------------- | ------------------------------------------------------------------------------------- |
| `ingest` | HTTP 1.4.0 → `POST` | Sends the execution argument (`$exec`, a native Splunk alert) to `/api/alerts/splunk` |
| `notify` | HTTP 1.4.0 → `POST` | Posts a ChatOps message using `$ingest.body.triage.*` from the previous step          |

Things to notice:

- **`$exec`** is the data the workflow was started with (the SIEM alert).
- **`$ingest.body.triage.disposition`** references the previous node's output by its label. The
  HTTP app returns `{status, body, headers}`, with `body` already parsed as JSON.
- Shuffle stores the playbook (actions, branches) as JSON. Compare it with
  [`shuffle/soc-alert-playbook.json`](../shuffle/soc-alert-playbook.json).

## 2. Run it and read the execution

Click **Run**, paste this as the execution argument, and open the execution in **Explore runs**:

```json
{
  "sid": "lab-1",
  "search_name": "Access - Brute Force Access Behavior Detected - Rule",
  "result": {
    "_time": "1759500000",
    "signature": "Brute Force",
    "src": "203.0.113.50",
    "dest": "ws-lab",
    "user": "jdoe",
    "urgency": "high"
  }
}
```

Check each node's status and result. Then confirm the message landed in mock Slack:
<http://localhost:3002/slack/messages>, and the alert in the SOC console: <http://localhost:4173>.

## 3. Exercises (build these yourself)

Do them in the UI; that is the experience. Export the workflow afterwards (**⋮ → Export**) and
commit it under `shuffle/` to keep a record of your work.

1. **Condition (routing).** Add a condition on the branch `ingest → notify` so the message is sent
   only when `$ingest.body.triage.disposition` equals `true_positive`. Run it with
   `"src":"192.0.2.10"` (an allowlisted scanner → `false_positive`) and confirm `notify` is skipped.
2. **Second route.** Add a node that, for `needs_investigation`, posts a different message
   (“analyst review required”) with the priority and risk score.
3. **Human approval from the SOAR.** Add a node that lists pending containment for the alert:
   `GET http://ingestion-service:3001/api/responses/actions?alertId=$ingest.body.alertId&status=pending_approval`.
   Then add a **User Input** (or a second, manually triggered workflow) that approves one action with
   `POST http://ingestion-service:3001/api/responses/actions/<id>/decision`
   body `{"decision":"approved","reviewer":"shuffle-lab"}`. Verify the mock firewall:
   <http://localhost:3002/firewall/blocks>.
4. **Webhook trigger.** Replace the manual start with a **Webhook** trigger, copy its URL, and send
   an alert to it with `curl -X POST <webhook-url> -d @alert.json`. This is how a SIEM would call it.
5. **Enrichment inside the SOAR.** Call the Python enrichment service directly from Shuffle
   (`POST http://enrichment-service:3003/enrich` with the alert's indicators) and include the
   verdict in the ChatOps message. Note the trade-off: is enrichment better in the SOAR or in the
   pipeline? (Hint: quota, retries, testability.)
6. **Error handling.** Stop the ingestion service (`docker stop orchestrator-ingestion`) and run
   the workflow. Read how Shuffle reports the failure; add a failure branch that notifies the SOC.

## 4. What to say in an interview (truthfully)

- “I self-hosted Shuffle and built SOC workflows in it: a Splunk alert intake, conditional routing
  on triage results, ChatOps notifications, and a human-approval step that triggers containment
  through a REST API.”
- “I kept detection and policy logic in tested code and used the SOAR for orchestration,
  integrations and human workflow, which makes playbooks easier to test and version.”
- “I have not run Torq, XSOAR or Splunk SOAR in production; the concepts I practised (triggers,
  actions, data passing, conditions, approvals, execution history) map directly, and I would expect
  to ramp up on the vendor-specific integrations quickly.”
