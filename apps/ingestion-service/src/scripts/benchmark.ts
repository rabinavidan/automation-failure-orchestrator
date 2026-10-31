/**
 * Investigation benchmark: deterministic vs. single-agent vs. multi-agent on one labeled dataset.
 *
 *   npm run benchmark                                   # deterministic only, no model needed
 *   npm run benchmark -- --configs=deterministic,single_agent,multi_agent --reps=3
 *   npm run benchmark -- --configs=multi_agent --subset=smoke --reps=1   # quick iteration
 *
 * Agent configurations require a real local Ollama (AI_ENABLED=true, OLLAMA_HOST, OLLAMA_MODEL);
 * the deterministic demo stub and unreachable hosts are rejected. Timeouts, errors and empty
 * results are recorded as failures, not dropped. Output: benchmark/results/<stamp>/
 *   outcomes.jsonl (raw), summary.json (aggregate + run metadata), report.md (readable).
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { cpus, platform, release, totalmem } from 'os';
import { join, resolve } from 'path';
import { loadDataset, smokeSubset } from '../benchmark/dataset';
import {
  AGENT_CONFIGS,
  assertRealModel,
  runCase,
  summarize,
  type BenchmarkConfig,
  type CaseOutcome,
  type ConfigSummary,
} from '../benchmark/runner';
import { loadTriagePolicy } from '../services/alert-triage';
import { createOllamaClient } from '../services/failure-investigation-agent';
import { detectModelBackend } from '../services/runtime-capabilities';
import { SOC_GRAPH_VERSION } from '../services/soc-investigation';
import { loadRunbooks } from '../services/soc-runbooks';

const REPO_ROOT = resolve(__dirname, '../../../..');

function arg(name: string): string | undefined {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

function gitCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT })
      .toString()
      .trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

async function modelDigest(host: string, model: string): Promise<string | null> {
  try {
    const response = await fetch(`${host.replace(/\/$/, '')}/api/tags`);
    const body = (await response.json()) as { models?: { name: string; digest?: string }[] };
    return (
      body.models?.find((m) => m.name === model || m.name === `${model}:latest`)?.digest ?? null
    );
  } catch {
    return null;
  }
}

const fmt = (v: number | null | undefined, pct = true) =>
  v === null || v === undefined ? 'n/a' : pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(1);

function report(meta: Record<string, unknown>, summaries: ConfigSummary[]): string {
  const lines: string[] = [];
  lines.push(`# Investigation benchmark report`, '');
  lines.push('| Run metadata | |', '|---|---|');
  for (const [k, v] of Object.entries(meta)) lines.push(`| ${k} | ${JSON.stringify(v)} |`);
  lines.push('', '## Deterministic decision quality', '');
  lines.push(
    'Classification (CI) and triage disposition (SOC) are produced by deterministic rules. Agents never override them, so these numbers are the same for every configuration.',
    ''
  );
  const d = summaries[0].decision;
  lines.push('| Track | n | Accuracy | Macro-F1 |', '|---|---|---|---|');
  for (const [track, m] of Object.entries(d.byTrack)) {
    lines.push(`| ${track} | ${m.n} | ${fmt(m.accuracy)} | ${fmt(m.macroF1)} |`);
  }
  lines.push('', '| Split | n | Accuracy |', '|---|---|---|');
  for (const [split, m] of Object.entries(d.bySplit)) {
    lines.push(`| ${split} | ${m.n} | ${fmt(m.accuracy)} |`);
  }
  lines.push('', '## Agent quality (advisory output)', '');
  const agents = summaries.filter((s) => s.agent);
  if (agents.length === 0) {
    lines.push('No agent configuration was run in this report.');
  } else {
    lines.push(
      '| Metric | ' + agents.map((s) => s.config).join(' | ') + ' |',
      '|---|' + agents.map(() => '---').join('|') + '|'
    );
    const row = (label: string, pick: (s: ConfigSummary) => string) =>
      lines.push(`| ${label} | ${agents.map(pick).join(' | ')} |`);
    row('Applicable runs', (s) => String(s.agent!.applicable));
    row('Failure rate (timeout/error/empty)', (s) => fmt(s.agent!.failureRate));
    row('Action within acceptable policy', (s) => fmt(s.agent!.actionPolicyCompliance));
    row('Abstains on ambiguous cases', (s) => fmt(s.agent!.abstentionOnAmbiguous));
    row('Abstains on clear cases', (s) => fmt(s.agent!.abstentionOnClear));
    row('Runs with unsupported claims', (s) => fmt(s.agent!.unsupportedClaimRate));
    row('Citation validity (SOC runbooks)', (s) => fmt(s.agent!.citationValidity));
    row('Required tools used', (s) => fmt(s.agent!.requiredToolCoverage));
    row('Forbidden tool use', (s) => fmt(s.agent!.forbiddenToolUse));
    row('Deterministic evaluator pass rate', (s) => fmt(s.agent!.evaluatorPassRate));
    row('Safety violations (zero tolerance)', (s) => String(s.agent!.safetyViolations));
  }
  lines.push('', '## Cost (reported separately from quality)', '');
  lines.push(
    '| Config | Latency p50 ms | Latency p95 ms | Model calls/case | Prompt tokens/case | Completion tokens/case |',
    '|---|---|---|---|---|---|'
  );
  for (const s of summaries) {
    lines.push(
      `| ${s.config} | ${fmt(s.cost.latencyMsP50, false)} | ${fmt(s.cost.latencyMsP95, false)} | ${fmt(s.cost.modelCallsPerCase, false)} | ${fmt(s.cost.promptTokensPerCase, false)} | ${fmt(s.cost.completionTokensPerCase, false)} |`
    );
  }
  lines.push(
    '',
    '## Limitations',
    '',
    '- Dataset labels are synthetic and AI-authored; they are not human-validated ground truth.',
    '- Small sample: percentages describe this dataset only, not production behaviour.',
    '- Local inference cost is compute time on the recorded hardware, not zero cost.',
    '- RAG is off for agent runs (no repository index in the harness); retrieval is measured separately.',
    '- The SOC track has no single-agent graph, so SOC agent metrics exist only for multi_agent.'
  );
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const datasetPath = resolve(REPO_ROOT, arg('dataset') ?? 'benchmark/datasets/signalops-v1.json');
  const configs = (arg('configs') ?? 'deterministic').split(',') as BenchmarkConfig[];
  const subset = arg('subset') ?? 'full';
  const reps = Number.parseInt(arg('reps') ?? (subset === 'smoke' ? '1' : '3'), 10);
  const caseTimeoutMs = Number.parseInt(arg('timeout-ms') ?? '180000', 10);
  for (const c of configs) {
    if (!['deterministic', ...AGENT_CONFIGS].includes(c)) throw new Error(`unknown config ${c}`);
  }

  const dataset = loadDataset(datasetPath);
  const cases = subset === 'smoke' ? smokeSubset(dataset.cases) : dataset.cases;
  const needsModel = configs.some((c) => AGENT_CONFIGS.includes(c));

  let client;
  let model: string | undefined;
  let digest: string | null = null;
  if (needsModel) {
    process.env.AI_ENABLED = process.env.AI_ENABLED ?? 'true';
    assertRealModel(await detectModelBackend());
    ({ client, model } = createOllamaClient());
    digest = await modelDigest(process.env.OLLAMA_HOST ?? 'http://localhost:11434', model);
    if (subset === 'full' && reps < 3) {
      console.warn('Warning: a full agent benchmark should use --reps=3 or more.');
    }
  }
  // Keep the harness independent of a repository index.
  process.env.RAG_ENABLED = 'false';

  const policy = loadTriagePolicy(resolve(REPO_ROOT, 'config/soc-triage-policy.json'));
  if (policy.error) throw new Error(`triage policy invalid: ${policy.error}`);
  const runbooks = loadRunbooks(resolve(REPO_ROOT, 'docs/runbooks'));

  const outcomes: CaseOutcome[] = [];
  for (const config of configs) {
    const configReps = config === 'deterministic' ? 1 : reps;
    for (let repetition = 0; repetition < configReps; repetition++) {
      for (const c of cases) {
        const outcome = await runCase(c, config, repetition, {
          client,
          model,
          policy: policy.policy,
          runbooks,
          socNow: dataset.socNow,
          caseTimeoutMs,
        });
        outcomes.push(outcome);
        if (config !== 'deterministic') {
          console.log(`${config} rep ${repetition} ${c.id}: ${outcome.status}`);
        }
      }
    }
  }

  const summaries = configs.map((c) => summarize(c, outcomes));
  const meta = {
    commit: gitCommit(),
    dataset: `${dataset.name}@${dataset.version}`,
    datasetCases: cases.length,
    subset,
    humanValidatedLabels: dataset.provenance.humanValidated,
    configs,
    repetitions: needsModel ? reps : 1,
    model: model ?? null,
    modelDigest: digest,
    modelBackend: needsModel ? 'real' : 'not used',
    graphVersions: {
      ci_single: 'failure-agent-v1',
      ci_multi: 'failure-supervisor-v1',
      soc: SOC_GRAPH_VERSION,
    },
    triagePolicyVersion: policy.policy.version,
    ragEnabled: false,
    seed: 'not set (Ollama sampling is not seeded by the graphs)',
    caseTimeoutMs,
    hardware: `${platform()} ${release()}, ${cpus()[0]?.model ?? 'cpu'} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GiB`,
    generatedAt: new Date().toISOString(),
  };

  const outDir = resolve(
    REPO_ROOT,
    arg('out') ?? join('benchmark/results', `${meta.generatedAt.replace(/[:.]/g, '-')}`)
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'outcomes.jsonl'),
    outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n'
  );
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ meta, summaries }, null, 2) + '\n');
  writeFileSync(join(outDir, 'report.md'), report(meta, summaries));
  console.log(report(meta, summaries));
  console.log(`Wrote ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
