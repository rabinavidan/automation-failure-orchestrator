# Investigation benchmark report

| Run metadata | |
|---|---|
| commit | "9b0898c8ac489124f0cd5a060d0a102398aeb0e7" |
| dataset | "signalops-investigation-benchmark@1.0.0" |
| datasetCases | 35 |
| subset | "full" |
| mergedShards | 6 |
| humanValidatedLabels | false |
| configs | ["deterministic","single_agent"] |
| repetitions | 3 |
| model | "qwen3:4b" |
| modelDigest | "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7" |
| modelBackend | "real" |
| graphVersions | {"ci_single":"failure-agent-v1","ci_multi":"failure-supervisor-v1","soc":"soc-supervisor-v1"} |
| triagePolicyVersion | "2026.10.1" |
| ragEnabled | false |
| seed | "not set (Ollama sampling is not seeded by the graphs)" |
| caseTimeoutMs | 900000 |
| hardware | "linux 7.0.0-1017-azure, AMD EPYC 7763 64-Core Processor x4, 16 GiB" |
| generatedAt | "2026-10-31T19:04:54.357Z" |

## Deterministic decision quality

Classification (CI) and triage disposition (SOC) are produced by deterministic rules. Agents never override them, so these numbers are the same for every configuration.

| Track | n | Accuracy | Macro-F1 |
|---|---|---|---|
| ci | 24 | 87.5% | 90.8% |
| soc | 11 | 100.0% | 100.0% |

| Split | n | Accuracy |
|---|---|---|
| dev | 19 | 100.0% |
| heldout | 16 | 81.3% |

## Agent quality (advisory output)

| Metric | single_agent |
|---|---|
| Applicable runs | 66 |
| Failure rate (timeout/error/empty) | 0.0% |
| Action within acceptable policy | 53.0% |
| Abstains on ambiguous cases | 0.0% |
| Abstains on clear cases | 19.0% |
| Runs with unsupported claims | 1.5% |
| Citation validity (SOC runbooks) | n/a |
| Required tools used | 81.8% |
| Forbidden tool use | 0.0% |
| Deterministic evaluator pass rate | 98.5% |
| Safety violations (zero tolerance) | 0 |

## Cost (reported separately from quality)

| Config | Latency p50 ms | Latency p95 ms | Model calls/case | Prompt tokens/case | Completion tokens/case |
|---|---|---|---|---|---|
| deterministic | 0.0 | 1.0 | 0.0 | 0.0 | 0.0 |
| single_agent | 33611.0 | 53514.0 | 1.0 | 526.5 | 242.9 |

## Limitations

- Dataset labels are synthetic and AI-authored; they are not human-validated ground truth.
- Small sample: percentages describe this dataset only, not production behaviour.
- Local inference cost is compute time on the recorded hardware, not zero cost.
- RAG is off for agent runs (no repository index in the harness); retrieval is measured separately.
- The SOC track has no single-agent graph, so SOC agent metrics exist only for multi_agent.
