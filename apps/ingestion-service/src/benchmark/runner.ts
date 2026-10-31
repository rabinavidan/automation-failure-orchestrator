import { classify, triageAlert } from '@orchestrator/failure-classifier';
import type {
  AgentInvestigation,
  AlertTriage,
  SocInvestigation,
  TriagePolicy,
} from '@orchestrator/shared-types';
import { evaluateAgentInvestigation } from '../services/agent-evaluation';
import {
  runFailureInvestigationGraph,
  type InvestigationContext,
  type InvestigationModel,
} from '../services/failure-investigation-agent';
import { createMultiAgentInvestigationGraph } from '../services/multi-agent-investigation';
import type { ModelBackend } from '../services/runtime-capabilities';
import { evaluateSocInvestigation, extractIndicators } from '../services/soc-agent-evaluation';
import { runSocInvestigation } from '../services/soc-investigation';
import { selectRunbooks, type Runbook } from '../services/soc-runbooks';
import {
  buildCiInputs,
  buildSocInputs,
  type BenchmarkCase,
  type CiCase,
  type SocCase,
} from './dataset';
import { accuracy, confusion, macroF1, percentile, rate } from './metrics';

export type BenchmarkConfig = 'deterministic' | 'single_agent' | 'multi_agent';
export const AGENT_CONFIGS: BenchmarkConfig[] = ['single_agent', 'multi_agent'];

export type OutcomeStatus = 'ok' | 'not_applicable' | 'timeout' | 'error' | 'no_result';

export interface CaseOutcome {
  caseId: string;
  track: 'ci' | 'soc';
  family: string;
  split: 'dev' | 'heldout';
  ambiguous: boolean;
  config: BenchmarkConfig;
  repetition: number;
  status: OutcomeStatus;
  error?: string;
  /** Deterministic decision: classification (CI) or disposition (SOC). Agents never change it. */
  decision: { expected: string; predicted: string };
  agent?: {
    action: string;
    actionAcceptable: boolean;
    abstained: boolean;
    requiredToolsMissing: string[];
    forbiddenToolsUsed: string[];
    unsupportedClaims: string[];
    citationValid: boolean | null;
    safetyViolation: boolean;
    evaluatorPassed: boolean;
    evaluatorFailures: string[];
  };
  cost: { latencyMs: number; modelCalls: number; promptTokens: number; completionTokens: number };
}

/** Wraps a model client to count calls, tokens and latency without touching the graphs. */
export function meterClient(client: InvestigationModel) {
  const totals = { modelCalls: 0, promptTokens: 0, completionTokens: 0, modelMs: 0 };
  const metered: InvestigationModel = {
    async chat(input) {
      const started = Date.now();
      const response = await client.chat(input);
      totals.modelCalls += 1;
      totals.modelMs += Date.now() - started;
      const usage = response as { prompt_eval_count?: number; eval_count?: number };
      totals.promptTokens += usage.prompt_eval_count ?? 0;
      totals.completionTokens += usage.eval_count ?? 0;
      return response;
    },
  };
  return { client: metered, totals };
}

/**
 * Agent configurations measure model quality, so they must run against a real model.
 * The demo stub and an unreachable host are rejected before any case runs.
 */
export function assertRealModel(probe: {
  backend: ModelBackend;
  modelInstalled: boolean | null;
}): void {
  if (probe.backend !== 'real') {
    throw new Error(
      `Agent benchmark requires a real local model; detected backend "${probe.backend}". ` +
        'Stub output is not model-quality evidence. Run --configs=deterministic or start Ollama.'
    );
  }
  if (probe.modelInstalled === false) {
    throw new Error('Configured OLLAMA_MODEL is not pulled on the Ollama host.');
  }
}

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

function ciUnsupportedClaims(investigation: AgentInvestigation, c: CiCase): string[] {
  const text = [
    investigation.suspectedRootCause,
    investigation.explanation,
    ...investigation.evidence,
    ...(investigation.specialistReports ?? []).flatMap((r) => [r.summary, ...r.findings]),
  ].join('\n');
  const allowedKeys = new Set(
    [c.ci.existingIssue, c.ci.history?.jiraIssueKey].filter((k): k is string => Boolean(k))
  );
  const allowedIocs = new Set(extractIndicators(c.ci.error?.message ?? ''));
  const keys = (text.match(JIRA_KEY) ?? []).filter((k) => !allowedKeys.has(k));
  const iocs = extractIndicators(text).filter((i) => !allowedIocs.has(i));
  return [...new Set([...keys.map((k) => `jira:${k}`), ...iocs.map((i) => `ioc:${i}`)])];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`case timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    );
  });
}

export interface RunOptions {
  client?: InvestigationModel;
  model?: string;
  policy: TriagePolicy;
  runbooks: Runbook[];
  socNow: string;
  caseTimeoutMs: number;
}

function zeroCost(latencyMs = 0) {
  return { latencyMs, modelCalls: 0, promptTokens: 0, completionTokens: 0 };
}

async function runCiCase(
  c: CiCase,
  config: BenchmarkConfig,
  repetition: number,
  opts: RunOptions
): Promise<CaseOutcome> {
  const started = Date.now();
  const inputs = buildCiInputs(c);
  const predicted = classify({
    test: inputs.test,
    failureHistory: inputs.history ?? undefined,
    existingJiraIssue: inputs.existingIssue?.key,
  });
  const base = {
    caseId: c.id,
    track: 'ci' as const,
    family: c.family,
    split: c.split,
    ambiguous: Boolean(c.ambiguous),
    config,
    repetition,
    decision: { expected: c.expected.classification, predicted },
  };
  if (config === 'deterministic')
    return { ...base, status: 'ok', cost: zeroCost(Date.now() - started) };
  // Production investigates failed tests only.
  if (c.ci.status !== 'failed') return { ...base, status: 'not_applicable', cost: zeroCost() };

  const { client, totals } = meterClient(opts.client!);
  const context: InvestigationContext = {
    test: inputs.test,
    run: inputs.run,
    fingerprint: inputs.fingerprint,
    deterministicClassification: predicted,
    history: inputs.history,
    existingIssue: inputs.existingIssue,
  };
  let investigation: AgentInvestigation | undefined;
  try {
    investigation = await withTimeout(
      config === 'multi_agent'
        ? createMultiAgentInvestigationGraph(client, { requireApproval: false })
            .invoke({
              context,
              model: opts.model!,
              reports: [],
              toolsUsed: [],
              sources: [],
              result: undefined,
              approvalStatus: 'not_required' as const,
            })
            .then((state) => state.result as AgentInvestigation | undefined)
        : runFailureInvestigationGraph(context, client, opts.model!, { requireApproval: false }),
      opts.caseTimeoutMs
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      status: message.includes('timed out') ? 'timeout' : 'error',
      error: message,
      cost: { latencyMs: Date.now() - started, ...totals },
    };
  }
  const cost = { latencyMs: Date.now() - started, ...totals };
  if (!investigation) return { ...base, status: 'no_result', cost };

  const evaluation = evaluateAgentInvestigation(investigation, {
    multiAgentExpected: config === 'multi_agent',
  });
  const tools = investigation.toolsUsed;
  return {
    ...base,
    status: 'ok',
    agent: {
      action: investigation.recommendedAction,
      actionAcceptable: c.expected.acceptableActions.includes(investigation.recommendedAction),
      abstained: investigation.recommendedAction === 'human_review',
      requiredToolsMissing: c.expected.requiredTools.filter((t) => !tools.includes(t)),
      forbiddenToolsUsed: c.expected.forbiddenTools.filter((t) => tools.includes(t)),
      unsupportedClaims: ciUnsupportedClaims(investigation, c),
      citationValid: null,
      safetyViolation: !evaluation.metrics.safeHighRiskPolicy,
      evaluatorPassed: evaluation.passed,
      evaluatorFailures: evaluation.failures,
    },
    cost,
  };
}

const INVESTIGATED_DISPOSITIONS = new Set(['true_positive', 'needs_investigation']);

async function runSocCase(
  c: SocCase,
  config: BenchmarkConfig,
  repetition: number,
  opts: RunOptions
): Promise<CaseOutcome> {
  const started = Date.now();
  const { alert, enrichment } = buildSocInputs(c, opts.socNow);
  const triage: AlertTriage = triageAlert({
    alert,
    ingestionStatus: c.soc.suppressed ? 'suppressed' : 'new',
    enrichment,
    occurrenceCount: c.soc.occurrenceCount,
    policy: opts.policy,
    now: new Date(opts.socNow),
  });
  const base = {
    caseId: c.id,
    track: 'soc' as const,
    family: c.family,
    split: c.split,
    ambiguous: Boolean(c.ambiguous),
    config,
    repetition,
    decision: { expected: c.expected.disposition, predicted: triage.disposition },
  };
  if (config === 'deterministic')
    return { ...base, status: 'ok', cost: zeroCost(Date.now() - started) };
  // Production investigates true positives and the analyst queue only.
  if (!INVESTIGATED_DISPOSITIONS.has(triage.disposition)) {
    return { ...base, status: 'not_applicable', cost: zeroCost() };
  }
  if (config === 'single_agent') {
    // The SOC track has no single-agent graph; report that instead of inventing one.
    return { ...base, status: 'not_applicable', cost: zeroCost() };
  }

  const runbooks = selectRunbooks(triage.mitre.techniques, opts.runbooks);
  const { client, totals } = meterClient(opts.client!);
  let investigation: SocInvestigation | undefined;
  try {
    investigation = await withTimeout(
      runSocInvestigation({ alert, triage, enrichment, runbooks }, client, opts.model!),
      opts.caseTimeoutMs
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      status: message.includes('timed out') ? 'timeout' : 'error',
      error: message,
      cost: { latencyMs: Date.now() - started, ...totals },
    };
  }
  const cost = { latencyMs: Date.now() - started, ...totals };
  if (!investigation) return { ...base, status: 'no_result', cost };

  const evaluation = evaluateSocInvestigation(investigation, {
    alert,
    triage,
    enrichment,
    suppliedRunbooks: runbooks.map((r) => r.file),
  });
  const contained = investigation.recommendedResponse === 'contain';
  return {
    ...base,
    status: 'ok',
    agent: {
      action: investigation.recommendedResponse,
      actionAcceptable: c.expected.acceptableResponses.includes(investigation.recommendedResponse),
      abstained: investigation.recommendedResponse === 'investigate',
      requiredToolsMissing: [],
      forbiddenToolsUsed: [],
      unsupportedClaims: evaluation.metrics.iocGrounded
        ? []
        : evaluation.failures.filter((f) => f.startsWith('investigation mentions')),
      citationValid: evaluation.metrics.runbookGrounded,
      safetyViolation:
        (contained &&
          c.expected.approvalRequiredIfContain &&
          !investigation.requiresHumanApproval) ||
        !evaluation.metrics.safeContainmentPolicy,
      evaluatorPassed: evaluation.passed,
      evaluatorFailures: evaluation.failures,
    },
    cost,
  };
}

export async function runCase(
  c: BenchmarkCase,
  config: BenchmarkConfig,
  repetition: number,
  opts: RunOptions
): Promise<CaseOutcome> {
  return c.track === 'ci'
    ? runCiCase(c, config, repetition, opts)
    : runSocCase(c, config, repetition, opts);
}

type Num = number | null;

export interface ConfigSummary {
  config: BenchmarkConfig;
  outcomes: number;
  decision: {
    note: string;
    byTrack: Record<string, { n: number; accuracy: Num; macroF1: Num }>;
    bySplit: Record<string, { n: number; accuracy: Num }>;
    confusion: Record<string, Record<string, Record<string, number>>>;
  };
  agent: {
    applicable: number;
    notApplicable: number;
    failureRate: Num;
    failures: Record<string, number>;
    actionPolicyCompliance: Num;
    abstentionOnAmbiguous: Num;
    abstentionOnClear: Num;
    unsupportedClaimRate: Num;
    citationValidity: Num;
    requiredToolCoverage: Num;
    forbiddenToolUse: Num;
    evaluatorPassRate: Num;
    safetyViolations: number;
  } | null;
  cost: {
    latencyMsP50: Num;
    latencyMsP95: Num;
    modelCallsPerCase: Num;
    promptTokensPerCase: Num;
    completionTokensPerCase: Num;
  };
}

function mean(values: number[]): Num {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarize(config: BenchmarkConfig, outcomes: CaseOutcome[]): ConfigSummary {
  const mine = outcomes.filter((o) => o.config === config);
  // Decisions are deterministic, so take one repetition per case for decision metrics.
  const firstRep = mine.filter((o) => o.repetition === 0);
  const byTrack: ConfigSummary['decision']['byTrack'] = {};
  const conf: ConfigSummary['decision']['confusion'] = {};
  for (const track of ['ci', 'soc']) {
    const pairs = firstRep.filter((o) => o.track === track).map((o) => o.decision);
    byTrack[track] = { n: pairs.length, accuracy: accuracy(pairs), macroF1: macroF1(pairs) };
    conf[track] = confusion(pairs);
  }
  const bySplit: ConfigSummary['decision']['bySplit'] = {};
  for (const split of ['dev', 'heldout']) {
    const pairs = firstRep.filter((o) => o.split === split).map((o) => o.decision);
    bySplit[split] = { n: pairs.length, accuracy: accuracy(pairs) };
  }

  let agent: ConfigSummary['agent'] = null;
  if (config !== 'deterministic') {
    const applicable = mine.filter((o) => o.status !== 'not_applicable');
    const ok = applicable.filter((o) => o.status === 'ok' && o.agent);
    const failures: Record<string, number> = {};
    for (const o of applicable.filter((x) => x.status !== 'ok')) {
      failures[o.status] = (failures[o.status] ?? 0) + 1;
    }
    const a = ok.map((o) => o.agent!);
    agent = {
      applicable: applicable.length,
      notApplicable: mine.length - applicable.length,
      // Timeouts, errors and empty results count as failures, never as exclusions.
      failureRate: rate(applicable.map((o) => o.status !== 'ok')),
      failures,
      actionPolicyCompliance: rate(a.map((x) => x.actionAcceptable)),
      abstentionOnAmbiguous: rate(ok.filter((o) => o.ambiguous).map((o) => o.agent!.abstained)),
      abstentionOnClear: rate(ok.filter((o) => !o.ambiguous).map((o) => o.agent!.abstained)),
      unsupportedClaimRate: rate(a.map((x) => x.unsupportedClaims.length > 0)),
      citationValidity: rate(
        a.filter((x) => x.citationValid !== null).map((x) => x.citationValid === true)
      ),
      requiredToolCoverage: rate(a.map((x) => x.requiredToolsMissing.length === 0)),
      forbiddenToolUse: rate(a.map((x) => x.forbiddenToolsUsed.length > 0)),
      evaluatorPassRate: rate(a.map((x) => x.evaluatorPassed)),
      safetyViolations: a.filter((x) => x.safetyViolation).length,
    };
  }

  const costed = mine.filter((o) => o.status !== 'not_applicable');
  return {
    config,
    outcomes: mine.length,
    decision: {
      note: 'Deterministic classification/triage; agents never override it, so it is identical across configurations.',
      byTrack,
      bySplit,
      confusion: conf,
    },
    agent,
    cost: {
      latencyMsP50: percentile(
        costed.map((o) => o.cost.latencyMs),
        50
      ),
      latencyMsP95: percentile(
        costed.map((o) => o.cost.latencyMs),
        95
      ),
      modelCallsPerCase: mean(costed.map((o) => o.cost.modelCalls)),
      promptTokensPerCase: mean(costed.map((o) => o.cost.promptTokens)),
      completionTokensPerCase: mean(costed.map((o) => o.cost.completionTokens)),
    },
  };
}

/**
 * Combine shard outputs. Duplicate (config, case, repetition) records, e.g. from a re-run shard,
 * are rejected rather than silently double-counted.
 */
export function mergeOutcomes(parts: CaseOutcome[][]): CaseOutcome[] {
  const seen = new Set<string>();
  const merged: CaseOutcome[] = [];
  for (const outcome of parts.flat()) {
    const key = `${outcome.config}|${outcome.caseId}|${outcome.repetition}`;
    if (seen.has(key)) throw new Error(`duplicate outcome ${key} across shards`);
    seen.add(key);
    merged.push(outcome);
  }
  return merged;
}
