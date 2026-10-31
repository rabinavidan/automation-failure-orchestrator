# SignalOps flagship release candidate 1

Release notes for the flagship work (milestones M0–M7). Each milestone merged through its own
PR with green CI. Publishing, tagging and deployment are left to the repository's release
workflow and the owner.

## Highlights

| Milestone | PR                                                                            | What changed                                                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 + M1   | [#48](https://github.com/rabinavidan/automation-failure-orchestrator/pull/48) | Removed two malicious credential-exfiltration workflows found on `main`. Production audit passes (express 4.22.3, zod 4 migration). Baseline inventory.                                                        |
| M2        | [#49](https://github.com/rabinavidan/automation-failure-orchestrator/pull/49) | `GET /api/capabilities`. Each investigation records its model backend (`real` / `stub` / `unreachable` / `disabled`). Dashboard mode strip. `demo:cleanup`. README rewrite.                                    |
| M3        | [#51](https://github.com/rabinavidan/automation-failure-orchestrator/pull/51) | 35-case benchmark (deterministic / single / multi-agent), stub-refusing harness, retrieval metrics, IOC grounding fixes (defanged, IPv6, domains), embedding-model filter for RAG, manual real-model workflow. |
| M4        | [#52](https://github.com/rabinavidan/automation-failure-orchestrator/pull/52) | MCP evidence server (Streamable HTTP) with HMAC scope tokens, read-only tools, per-call audit and 11 contract tests.                                                                                           |
| M5        | [#53](https://github.com/rabinavidan/automation-failure-orchestrator/pull/53) | Role-checked reviewer authentication. Audit identity comes from auth. CI asserts concurrent approvals produce one transition. Action-semantics doc.                                                            |
| M6        | [#56](https://github.com/rabinavidan/automation-failure-orchestrator/pull/56) | Benchmark card from committed reports, investigation telemetry (calls, tokens, time), stub warning in the dossier, single-agent telemetry.                                                                     |
| M7        | this PR                                                                       | Two-minute demo, portfolio summary, architecture diagram, verification matrix.                                                                                                                                 |

## Breaking changes

- Approval, containment, rollback, reclassify and reindex endpoints now require
  `Authorization: Bearer <token>` (`REVIEWER_TOKENS`). Without identities they return 503.
- Validation error messages follow zod 4 wording. The `formErrors` / `fieldErrors` shape is
  unchanged.
- `confidenceCalibrated` is renamed to `confidenceInRange` in evaluator results.
- New migration `014_add_agent_model_backend.sql`.

## Verification matrix

| Check                                            | Local (this work)              | CI (GitHub Actions)   | Real model                      | Live external       | Cloud             |
| ------------------------------------------------ | ------------------------------ | --------------------- | ------------------------------- | ------------------- | ----------------- |
| Lint, format, typecheck, unit + evaluation tests | yes                            | yes, every PR         | n/a                             | n/a                 | n/a               |
| Dashboard oxlint + build                         | yes                            | via Docker build      | n/a                             | n/a                 | n/a               |
| Python enrichment (ruff, mypy, pytest)           | yes (3.13)                     | yes (3.12)            | n/a                             | no (mock providers) | n/a               |
| Production dependency audit (high)               | yes                            | yes                   | n/a                             | n/a                 | n/a               |
| Docker smoke incl. auth + concurrent approvals   | native services                | yes                   | no                              | no                  | n/a               |
| SQS worker path                                  | no                             | yes, on moto emulator | no                              | no                  | **no**            |
| Shuffle SOAR playbook                            | no                             | yes                   | n/a                             | n/a                 | n/a               |
| Terraform validate + Checkov                     | no                             | yes                   | n/a                             | n/a                 | **never applied** |
| Benchmark, deterministic                         | yes                            | via unit tests        | n/a                             | n/a                 | n/a               |
| Benchmark, single and multi-agent                | harness only (scripted client) | no                    | **not run**                     | n/a                 | n/a               |
| MCP evidence tools                               | contract tests and live local  | contract tests        | **no model-initiated call yet** | n/a                 | n/a               |
| Dashboard flows (Chromium)                       | yes, live services, stub model | no                    | no                              | n/a                 | n/a               |

## Known limitations

- Real-model evidence is one smoke run (qwen3:4b, 20 cases, 1 rep; [report](../benchmark/results/real-2026-10-31-qwen3-4b-smoke/report.md)). It exposed a prompt-only high-risk rule, now code-enforced. The full sharded run is pending.
- Benchmark labels are synthetic and AI-authored (`humanValidated: false`).
- External actions after an approval are not exactly-once (no outbox).
- Reviewer auth is demo bearer tokens. The demo tokens are public.
- No video recording. See the two-minute demo script.
- The session that produced this work could not delete merged branches (git proxy policy).
  Enable "Automatically delete head branches" in repository settings.
