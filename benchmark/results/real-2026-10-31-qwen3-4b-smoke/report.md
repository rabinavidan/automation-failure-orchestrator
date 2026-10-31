# Investigation benchmark report

| Run metadata | |
|---|---|
| commit | "581ecd1579717115897b37709bf3d97bfd027630" |
| dataset | "signalops-investigation-benchmark@1.0.0" |
| datasetCases | 20 |
| subset | "smoke" |
| humanValidatedLabels | false |
| configs | ["deterministic","single_agent","multi_agent"] |
| repetitions | 1 |
| model | "qwen3:4b" |
| modelDigest | "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7" |
| modelBackend | "real" |
| graphVersions | {"ci_single":"failure-agent-v1","ci_multi":"failure-supervisor-v1","soc":"soc-supervisor-v1"} |
| triagePolicyVersion | "2026.10.1" |
| ragEnabled | false |
| seed | "not set (Ollama sampling is not seeded by the graphs)" |
| caseTimeoutMs | 900000 |
| hardware | "linux 7.0.0-1017-azure, AMD EPYC 7763 64-Core Processor x4, 16 GiB" |
| generatedAt | "2026-10-31T12:38:57.314Z" |

## Deterministic decision quality

Classification (CI) and triage disposition (SOC) are produced by deterministic rules. Agents never override them, so these numbers are the same for every configuration.

| Track | n | Accuracy | Macro-F1 |
|---|---|---|---|
| ci | 11 | 90.9% | 91.1% |
| soc | 9 | 100.0% | 100.0% |

| Split | n | Accuracy |
|---|---|---|
| dev | 10 | 100.0% |
| heldout | 10 | 90.0% |

## Agent quality (advisory output)

| Metric | single_agent | multi_agent |
|---|---|---|
| Applicable runs | 10 | 15 |
| Failure rate (timeout/error/empty) | 100.0% | 13.3% |
| Action within acceptable policy | n/a | 53.8% |
| Abstains on ambiguous cases | n/a | 100.0% |
| Abstains on clear cases | n/a | 45.5% |
| Runs with unsupported claims | n/a | 0.0% |
| Citation validity (SOC runbooks) | n/a | 100.0% |
| Required tools used | n/a | 84.6% |
| Forbidden tool use | n/a | 0.0% |
| Deterministic evaluator pass rate | n/a | 61.5% |
| Safety violations (zero tolerance) | 0 | 5 |

## Cost (reported separately from quality)

| Config | Latency p50 ms | Latency p95 ms | Model calls/case | Prompt tokens/case | Completion tokens/case |
|---|---|---|---|---|---|
| deterministic | 0.0 | 1.0 | 0.0 | 0.0 | 0.0 |
| single_agent | 29.0 | 2580.0 | 0.0 | 0.0 | 0.0 |
| multi_agent | 228667.0 | 316472.0 | 3.7 | 1661.5 | 847.0 |

## Limitations

- Dataset labels are synthetic and AI-authored; they are not human-validated ground truth.
- Small sample: percentages describe this dataset only, not production behaviour.
- Local inference cost is compute time on the recorded hardware, not zero cost.
- RAG is off for agent runs (no repository index in the harness); retrieval is measured separately.
- The SOC track has no single-agent graph, so SOC agent metrics exist only for multi_agent.
