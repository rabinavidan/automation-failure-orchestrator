# Investigation benchmark report

| Run metadata         |                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------- |
| commit               | "2e05d89adb98dae4dfe6661c7c70ce8fa027966f"                                                    |
| dataset              | "signalops-investigation-benchmark@1.0.0"                                                     |
| datasetCases         | 35                                                                                            |
| subset               | "full"                                                                                        |
| humanValidatedLabels | false                                                                                         |
| configs              | ["deterministic"]                                                                             |
| repetitions          | 1                                                                                             |
| model                | null                                                                                          |
| modelDigest          | null                                                                                          |
| modelBackend         | "not used"                                                                                    |
| graphVersions        | {"ci_single":"failure-agent-v1","ci_multi":"failure-supervisor-v1","soc":"soc-supervisor-v1"} |
| triagePolicyVersion  | "2026.10.1"                                                                                   |
| ragEnabled           | false                                                                                         |
| seed                 | "not set (Ollama sampling is not seeded by the graphs)"                                       |
| caseTimeoutMs        | 180000                                                                                        |
| hardware             | "linux 6.18.44-fc-v185, Intel(R) Xeon(R) Processor @ 2.10GHz x4, 16 GiB"                      |
| generatedAt          | "2026-10-31T08:16:07.366Z"                                                                    |

## Deterministic decision quality

Classification (CI) and triage disposition (SOC) are produced by deterministic rules. Agents never override them, so these numbers are the same for every configuration.

| Track | n   | Accuracy | Macro-F1 |
| ----- | --- | -------- | -------- |
| ci    | 24  | 87.5%    | 90.8%    |
| soc   | 11  | 100.0%   | 100.0%   |

| Split   | n   | Accuracy |
| ------- | --- | -------- |
| dev     | 19  | 100.0%   |
| heldout | 16  | 81.3%    |

## Agent quality (advisory output)

No agent configuration was run in this report.

## Cost (reported separately from quality)

| Config        | Latency p50 ms | Latency p95 ms | Model calls/case | Prompt tokens/case | Completion tokens/case |
| ------------- | -------------- | -------------- | ---------------- | ------------------ | ---------------------- |
| deterministic | 0.0            | 1.0            | 0.0              | 0.0                | 0.0                    |

## Limitations

- Dataset labels are synthetic and AI-authored; they are not human-validated ground truth.
- Small sample: percentages describe this dataset only, not production behaviour.
- Local inference cost is compute time on the recorded hardware, not zero cost.
- RAG is off for agent runs (no repository index in the harness); retrieval is measured separately.
- The SOC track has no single-agent graph, so SOC agent metrics exist only for multi_agent.
