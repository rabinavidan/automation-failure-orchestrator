# Flagship progress

Tracks the flagship implementation brief milestone by milestone. Evidence levels as in
[flagship-baseline.md](flagship-baseline.md): local, CI, real-model, live, cloud.

| Milestone                          | Status                      | Evidence                                                             |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| M0 Baseline                        | done                        | [flagship-baseline.md](flagship-baseline.md)                         |
| M1 Dependency security / CI        | done locally; PR CI pending | `9fb780b`. Production audit exits 0, quality and smoke pass locally. |
| M2 Positioning and execution modes | not started                 |                                                                      |
| M3 Benchmark                       | not started                 |                                                                      |
| M4 MCP evidence tools              | not started                 |                                                                      |
| M5 Recovery and authorization      | not started                 |                                                                      |
| M6 Dashboard                       | not started                 |                                                                      |
| M7 Release candidate               | not started                 |                                                                      |

## Blockers and environment notes

- Docker Hub returned HTTP 429 in the verification container, so Compose-based checks
  (`demo:aws-local`, Shuffle, image scans) rely on GitHub Actions.
- No Ollama or GPU in the verification container, so any real-model result needs a
  machine with Ollama.
- `INTEGRATION_MODE` is a label only: the Jira/Slack adapters route by `JIRA_BASE_URL` and
  `SLACK_WEBHOOK_URL`. The capability report therefore shows the target origins.
- `demo:cleanup` removes only CI runs with `triggered_by='demo-script'` (and cascades).
  SOC demo alerts, `failure_history` and LangGraph checkpoint rows have no reliable demo marker
  and are left in place.
- Real-model mode (`backend: real`, model pulled check) is unit-tested with a fake Ollama but not
  exercised against a real Ollama here.
- Malicious workflows found on `main` were removed by #48. Credential and account
  remediation is owner-only.
