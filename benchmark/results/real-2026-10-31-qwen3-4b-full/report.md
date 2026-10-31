# Investigation benchmark report

| Run metadata | |
|---|---|
| commit | "dda7e36569c3212b5384415d456fec62a7036b4d" |
| dataset | "signalops-investigation-benchmark@1.0.0" |
| datasetCases | 35 |
| subset | "full" |
| mergedShards | 12 |
| humanValidatedLabels | false |
| configs | ["deterministic","single_agent","multi_agent"] |
| repetitions | 3 |
| model | "qwen3:4b" |
| modelDigest | "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7" |
| modelBackend | "real" |
| graphVersions | {"ci_single":"failure-agent-v1","ci_multi":"failure-supervisor-v1","soc":"soc-supervisor-v1"} |
| triagePolicyVersion | "2026.10.1" |
| ragEnabled | false |
| seed | "not set (Ollama sampling is not seeded by the graphs)" |
| caseTimeoutMs | 180000 |
| hardware | "linux 7.0.0-1017-azure, AMD EPYC 9V45 96-Core Processor x4, 16 GiB" |
| generatedAt | "2026-10-31T18:39:55.067Z" |

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

| Metric | single_agent | multi_agent |
|---|---|---|
| Applicable runs | 66 | 84 |
| Failure rate (timeout/error/empty) | 62.1% | 13.1% |
| Action within acceptable policy | 40.0% | 95.9% |
| Abstains on ambiguous cases | n/a | 100.0% |
| Abstains on clear cases | 24.0% | 83.1% |
| Runs with unsupported claims | 0.0% | 13.7% |
| Citation validity (SOC runbooks) | n/a | 100.0% |
| Required tools used | 76.0% | 84.9% |
| Forbidden tool use | 0.0% | 0.0% |
| Deterministic evaluator pass rate | 88.0% | 98.6% |
| Safety violations (zero tolerance) | 0 | 0 |

## Cost (reported separately from quality)

| Config | Latency p50 ms | Latency p95 ms | Model calls/case | Prompt tokens/case | Completion tokens/case |
|---|---|---|---|---|---|
| deterministic | 0.0 | 1.0 | 0.0 | 0.0 | 0.0 |
| single_agent | 300741.0 | 300770.0 | 0.4 | 199.2 | 715.4 |
| multi_agent | 108921.0 | 207408.0 | 3.7 | 1548.2 | 747.2 |

## Limitations

- Dataset labels are synthetic and AI-authored; they are not human-validated ground truth.
- Small sample: percentages describe this dataset only, not production behaviour.
- Local inference cost is compute time on the recorded hardware, not zero cost.
- RAG is off for agent runs (no repository index in the harness); retrieval is measured separately.
- The SOC track has no single-agent graph, so SOC agent metrics exist only for multi_agent.
