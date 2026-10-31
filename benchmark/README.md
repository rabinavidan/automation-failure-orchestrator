# Investigation benchmark

Measures whether SignalOps decisions and advisory investigations are correct, grounded and safe
on one labeled dataset, across three configurations:

| Configuration   | What runs                                                                                                   | Needs a model |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
| `deterministic` | Classification (CI) and triage (SOC) rules only                                                             | No            |
| `single_agent`  | CI: `failure-agent-v1` tool-calling graph. SOC: no single-agent graph exists, so reported as not applicable | Real Ollama   |
| `multi_agent`   | CI: `failure-supervisor-v1`. SOC: `soc-supervisor-v1`                                                       | Real Ollama   |

Agents only run where production runs them: CI investigations for failed tests, SOC
investigations for `true_positive` and `needs_investigation` alerts. Other cases are reported
as not applicable, not as passes.

## Run it

```bash
npm run benchmark                                    # deterministic, any machine, seconds
npm run benchmark -- --configs=deterministic,single_agent,multi_agent --reps=3   # full
npm run benchmark -- --configs=multi_agent --subset=smoke --reps=1              # quick iteration
npm run benchmark:retrieval                          # Recall@k / MRR, needs an index built with the active embedding model
```

Agent runs need `AI_ENABLED=true`, a reachable `OLLAMA_HOST` running real Ollama, and
`OLLAMA_MODEL` pulled. The harness **refuses** the deterministic demo stub, an unreachable host
and an unpulled model (`assertRealModel`). On GitHub, the manual **Real-model benchmark**
workflow (`.github/workflows/benchmark.yml`) runs the same command on a CPU runner with a pinned
Ollama image and uploads the results as an artifact.

Output goes to `benchmark/results/<timestamp>/`:

- `outcomes.jsonl`: one raw record per case, configuration and repetition
- `summary.json`: aggregates and run metadata (commit, dataset version, model and digest,
  graph versions, policy version, hardware, timeout, seed status)
- `report.md`: a readable comparison

## Datasets

- [`datasets/signalops-v1.json`](datasets/signalops-v1.json): 35 cases (24 CI, 11 SOC) in 20
  scenario families. Every case has the expected decision, acceptable actions, and required or
  forbidden tools where relevant. Several are deliberately adversarial to the deterministic
  rules (`regression-adversarial`), and some are marked `ambiguous`, where abstaining
  (`human_review` / `investigate`) is the appropriate answer.
- [`datasets/retrieval-v1.json`](datasets/retrieval-v1.json): 12 repository questions, each
  labeled with the paths an answer must come from. All other indexed files are distractors.

**Provenance:** synthetic and AI-authored (Claude Code). `humanValidated: false`. The labels are
the author's judgement and have not been reviewed by a human, so they are not ground truth.
Splits are by scenario family (`dev` / `heldout`); the loader rejects a family that appears in
both, so paraphrases of one incident never leak across splits.

## Metrics

Quality and cost are reported separately.

| Metric                          | Definition                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision accuracy, macro-F1     | Deterministic classification or disposition vs. label, per track and split. Agents never override decisions, so this is identical across configurations by design.                                   |
| Failure rate                    | Timeouts, model errors and empty results over applicable runs. They count as failures, never as exclusions.                                                                                          |
| Action within acceptable policy | Agent's `recommendedAction` / `recommendedResponse` is in the case's acceptable set.                                                                                                                 |
| Abstention                      | Rate of `human_review` (CI) or `investigate` (SOC), reported separately for ambiguous and clear cases. Both under- and over-abstention are visible.                                                  |
| Unsupported claims              | CI: Jira keys or network/file IOCs in the investigation that are absent from the case input. SOC: the `iocGrounded` evaluator (IPv4, IPv6, hashes, URLs, domains under listed TLDs, defanged forms). |
| Citation validity               | SOC: every cited runbook was actually supplied (`runbookGrounded`). A cited file existing does not prove it supports the claim; this metric checks existence only.                                   |
| Tool selection                  | Required tools used; forbidden tools not used.                                                                                                                                                       |
| Safety violations               | Zero tolerance: containment without required approval, or high-risk action without `human_review`.                                                                                                   |
| Cost                            | Latency p50/p95, model calls, prompt and completion tokens per applicable case. Local inference is compute time on the recorded hardware, not free.                                                  |
| Retrieval                       | Recall@1/3/5 and MRR over distinct documents. Search only compares chunks embedded with the active embedding model, so a stale index returns nothing instead of misleading rankings.                 |

## What the existing evaluators and judge are, and are not

- `agent-evaluation.ts` and `soc-agent-evaluation.ts` are deterministic code checks. Their
  `confidenceInRange` metric (formerly `confidenceCalibrated`) only checks values are within
  0..1. **It is not calibration.** Calibration needs labeled outcomes vs. stated confidence
  over many real-model runs, which this benchmark records (`outcomes.jsonl`) but does not yet
  analyse.
- `agent-judge.ts` is an LLM judge with a fixed rubric: groundedness, root-cause quality and
  explanation clarity (0..1 each), plus pass/fail and a rationale. Its agreement set
  (`judge-labeled-set.ts`) has **6** examples. Judge scores are supporting evidence only and are
  not part of this benchmark's headline numbers.

## Results

| Result                               | Status                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Deterministic baseline               | [`results/baseline-deterministic/report.md`](results/baseline-deterministic/report.md), measured                  |
| Single / multi-agent on a real model | **Not yet run.** No Ollama in the development container. Run the manual workflow or a local Ollama to produce it. |
| Retrieval                            | **Not yet run.** Needs an embedding model and an index.                                                           |
