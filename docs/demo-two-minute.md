# Two-minute demo

One incident from signal to evidence to controlled action, then the audit. No API keys,
accounts or GPU are needed. For the longer technical walkthrough, see
[`soc-interview-guide.md`](soc-interview-guide.md) and
[`platform-reference.md`](platform-reference.md).

## Prepare (before the call)

```bash
cp .env.example .env
docker compose up --build -d
npm run ollama:stub &   # optional: exercises the agent graphs, clearly labelled STUB
# for real inference instead: run Ollama, `ollama pull qwen3:4b`, set AI_ENABLED=true in .env
curl -s localhost:3001/api/capabilities | jq '.model.backend, .notes'
```

## The two minutes

| Time | Do                                                                                                 | Say                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open http://localhost:4173. Point at the mode strip under the title.                               | "Every screen says what is real. Here the model is the demo stub and Jira/Slack are mocks, and the UI never lets stub output pass as a real investigation."                                               |
| 0:15 | `npm run demo:new-regression`                                                                      | "A CI run posts a failing test. It is fingerprinted (UUIDs and timestamps stripped), checked for an existing Jira issue and classified by a priority-ordered rule chain."                                 |
| 0:35 | Click the failure in **Command center** to open the dossier.                                       | "The agents gathered evidence. This banner says the stub produced it, so it is not evidence of model quality. Below are the graph version, model calls and tokens, and the LangGraph timeline."           |
| 0:55 | `npm run demo:known-bug`                                                                           | "Same failure again: the label matches the open Jira issue, so it is updated, not duplicated. Deterministic code decides; the agent only advises."                                                        |
| 1:10 | `npm run demo:soc-response`, then open **SOC console**                                             | "Second domain. A brute-force alert is enriched by the Python service and triaged as a true positive. The playbook opens a ticket immediately, but the firewall block waits for a human."                 |
| 1:30 | **Approval queue**: sign in with `demo-soc-responder-token-0001`, then go back to the SOC console. | "Approvals are authenticated and role-checked by the server. The audit records my identity, not whatever name a client sends. Four simultaneous approvals produce exactly one execution; CI checks that." |
| 1:45 | **AI observability** → benchmark card                                                              | "Quality is measured, not asserted. This is the deterministic baseline on a 35-case labeled set, and the harness refuses to score a stub. Real-model results are the next run."                           |

## If asked

- "Is the AI real?" Show the mode strip and `GET /api/capabilities`. With Ollama running it
  reports `real` and the exact model.
- "What can the agent touch?" Read-only MCP evidence tools scoped by a token it never sees
  ([mcp-evidence.md](mcp-evidence.md)). Writes go through the deterministic executor.
- "What breaks?" [action-semantics.md](action-semantics.md): external delivery after an approval
  is not exactly-once, and there is no outbox yet.

## Recording status

No video has been recorded. A real-model walkthrough needs a machine with Ollama. Do not
record the stub run as AI inference; if you record it, keep the STUB banner on screen.
