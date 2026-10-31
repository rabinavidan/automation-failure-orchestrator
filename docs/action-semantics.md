# Action semantics: approvals, retries and what is guaranteed

This page states what the platform guarantees about side effects, and what it does not.
Each claim names the code and test that back it.

## Who can decide (server-enforced)

| Endpoint                                                   | Role            | Code                  |
| ---------------------------------------------------------- | --------------- | --------------------- |
| `POST /api/approvals/:threadId/decision` (CI human review) | `ci_reviewer`   | `routes/approvals.ts` |
| `POST /api/responses/actions/:id/decision` (containment)   | `soc_responder` | `routes/responses.ts` |
| `POST /api/responses/actions/:id/rollback`                 | `soc_responder` | `routes/responses.ts` |
| `POST /api/failures/:fingerprint/reclassify`               | `ci_reviewer`   | `routes/failures.ts`  |
| `POST /api/knowledge/reindex`                              | `admin`         | `routes/knowledge.ts` |

`admin` satisfies every role.

- **Identity source:** bearer tokens configured in `REVIEWER_TOKENS` (`name:roles:token;…`,
  `middleware/reviewer-auth.ts`). This is minimal demo authentication, not SSO. The demo tokens
  in `docker-compose.yml` and `.env.example` are public and only suitable for local use.
- **Audit identity:** always the authenticated name. A `reviewer` field in the request body is
  accepted for old clients and ignored.
- **Fail closed:** without configured identities, the endpoints return 503. A missing or unknown
  token returns 401, and the wrong role returns 403. All three happen before any state is read.
- **UI is not the boundary:** the dashboard signs in through `GET /api/auth/whoami` and hides
  buttons the role cannot use, but the API checks the role on every call.
- **Tests:** `reviewer-auth.test.ts` covers fail-closed, 401, 403 across tracks, and body
  spoofing. `scripts/ci-smoke.mjs` checks anonymous → 401 and wrong role → 403 against the
  running stack in CI.

## One decision, one transition

Both approval flows commit the decision with a conditional update:
`UPDATE … WHERE status = 'pending'` (CI) and `… WHERE status = 'pending_approval'` (SOC).
Postgres serializes concurrent attempts, so exactly one wins and the rest get **409**.

`ci-smoke.mjs` sends four concurrent approvals for one containment action against real Postgres.
It asserts one 200, three 409s and exactly one `executed` event in the action's audit trail.

## Delivery to external systems: not exactly-once

An atomic local decision does **not** make the external call exactly-once. What actually happens:

| Situation                                        | Behaviour                                                          | Consequence                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate webhook delivery (`runId`, SIEM retry) | Detected before processing (`duplicateRun` / `duplicate_delivery`) | No second ticket or notification                                                                                                  |
| Jira issue creation                              | Searches by fingerprint label first, then creates                  | Idempotent in practice. If the search itself errors, `searchByLabel` returns null and a duplicate issue is possible.              |
| CI approval approved, Jira/Slack call then fails | API returns 502. The approval stays `approved`.                    | **No automatic retry.** The action must be repeated manually. A transactional outbox would close this gap; it is not implemented. |
| CI approval: resuming the LangGraph thread fails | Approval is restored to `pending` (`restorePendingApproval`)       | The reviewer can decide again                                                                                                     |
| Containment approved, executor fails             | Action recorded as `failed` with the reason                        | Not retried automatically. Guards are re-checked at execution.                                                                    |
| Slack notification                               | Fire-once webhook                                                  | May be lost if Slack is down. Not retried.                                                                                        |

## Retries and redelivery

- **Model calls:** per-request timeout `OLLAMA_TIMEOUT_MS`, and at most 4 reasoning steps per
  graph (`MAX_REASONING_STEPS`). A timeout, schema-invalid output or a model error ends the
  investigation as `failed`, and deterministic routing continues. A failed model call is not
  retried inside a request.
- **MCP evidence tools:** 5 s per-tool deadline. Authorization and schema failures are permanent
  and are not retried.
- **SQS worker** (`INVESTIGATION_QUEUE=sqs`): a failed investigation leaves the message for
  redelivery (60 s visibility backoff), and after `maxReceiveCount = 3` it goes to the DLQ
  (`infra/terraform/sqs.tf`). Redelivery of already-completed work is a no-op, and poison
  messages are discarded (`investigation-queue.test.ts`). CI runs this path against moto
  (`demo:aws-local`), which is a local emulator, not AWS.
- **Restart:** LangGraph checkpoints and approval requests are stored in Postgres
  (`db/agent-checkpointer.ts`, migration 006). A paused CI investigation resumes from the
  persisted thread after an API restart.

## LLM and MCP cannot bypass policy

- Classification, triage and the action executor are deterministic. The agent's
  `recommendedAction` never triggers a write, except that `human_review` _adds_ a gate.
- SOC `applyGuardrails()` sets `requiresHumanApproval` in code. Containment steps must be
  `approval: required` (schema-enforced), and `guardAction()` runs both when an action is
  planned and when it executes.
- MCP evidence tools are read-only and scoped by a server-minted token
  ([mcp-evidence.md](mcp-evidence.md)). There is no tool that writes, executes or approves.
- Prompt wording is one layer. The enforcing layers are the role checks, conditional updates,
  guards and tool scope above.

## Not done in this scope

- Two-person approval for P1 isolation, and SSO/OIDC reviewer identity.
- An outbox with reconciliation for external actions after approval.
- Fault-injection tests that kill the API process mid-approval. The SQS worker's
  failure and redelivery behaviour is covered by unit tests and the moto demo.
