# Documentation

The [project README](../README.md) is the short overview. Everything else is grouped by what you
need it for.

## Reference: how the system works now

Kept current with the code. A change in behaviour updates these in the same pull request.

| Document                                              | Covers                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Platform reference](reference/platform-reference.md) | Architecture, data flow, agents, decision engine, fingerprinting, configuration, trade-offs         |
| [API](reference/api.md)                               | Authentication and reviewer roles, a worked example, enrichment and mock APIs                       |
| [`contracts/openapi.json`](../contracts/openapi.json) | The ingestion API, generated from the route registry and Zod schemas (`npm run contracts:export`)   |
| [Action semantics](reference/action-semantics.md)     | Which side effects are idempotent, retried or exactly-once, and what is not                         |
| [MCP evidence server](reference/mcp-evidence.md)      | The agents' read-only evidence tools and their scope tokens                                         |
| [Observability](reference/observability.md)           | OpenTelemetry traces and metrics, the Grafana LGTM stack                                            |
| [SOC track](reference/soc-automation-roadmap.md)      | Alert ingestion, enrichment, triage, advisory agents and response playbooks, milestone by milestone |
| [Runbooks](runbooks/README.md)                        | Incident runbooks; the SOC agents load them at runtime by ATT&CK technique                          |

## Guides: doing something with it

| Document                                         | Use it to                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| [Demo guide](guides/demo.md)                     | Run the two-minute walkthrough, every CI scenario and the SOC walkthrough |
| [Shuffle SOAR lab](guides/shuffle-soar-lab.md)   | Drive the SOC pipeline from a self-hosted Shuffle playbook                |
| [Portfolio summary](guides/portfolio-summary.md) | Describe the project accurately: verified claims and what not to claim    |
| [Tests](../tests/README.md)                      | Run the pytest and Playwright suites, layer by layer                      |
| [Benchmark](../benchmark/README.md)              | Run the labeled benchmark and read its results honestly                   |

## History: how it got here

Records of a point in time. They are not updated when the code changes.

| Document                                              | Records                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| [Architecture review](history/architecture-review.md) | The redundancy review and the nine-step improvement roadmap, with status |
| [Flagship baseline](history/flagship-baseline.md)     | What existed and what was verified before the flagship work              |
| [Flagship progress](history/flagship-progress.md)     | Progress through the flagship milestones                                 |
| [Release notes, RC1](history/release-notes-rc1.md)    | The first release candidate                                              |
