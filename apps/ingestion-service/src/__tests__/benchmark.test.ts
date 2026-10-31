import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { Message } from 'ollama';
import {
  BenchmarkDatasetSchema,
  loadDataset,
  smokeSubset,
  type CiCase,
} from '../benchmark/dataset';
import { accuracy, macroF1, meanReciprocalRank, percentile, recallAtK } from '../benchmark/metrics';
import { assertRealModel, runCase, summarize, type RunOptions } from '../benchmark/runner';
import { loadTriagePolicy } from '../services/alert-triage';
import type { InvestigationModel } from '../services/failure-investigation-agent';

const ROOT = resolve(__dirname, '../../../..');
const dataset = loadDataset(resolve(ROOT, 'benchmark/datasets/signalops-v1.json'));
const policy = loadTriagePolicy(resolve(ROOT, 'config/soc-triage-policy.json')).policy;
const baseOptions: RunOptions = {
  policy,
  runbooks: [],
  socNow: dataset.socNow,
  caseTimeoutMs: 5_000,
};

describe('benchmark dataset', () => {
  it('is valid, large enough, covers both tracks and is not human-validated', () => {
    expect(dataset.cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(dataset.cases.map((c) => c.track))).toEqual(new Set(['ci', 'soc']));
    expect(dataset.provenance.humanValidated).toBe(false);
    expect(dataset.cases.some((c) => c.ambiguous)).toBe(true);
  });

  it('rejects a family that leaks across dev and heldout', () => {
    const [first] = dataset.cases;
    const leaked = { ...dataset, cases: [first, { ...first, id: 'copy', split: 'heldout' }] };
    if (first.split === 'heldout') leaked.cases[1].split = 'dev' as never;
    expect(BenchmarkDatasetSchema.safeParse(leaked).success).toBe(false);
  });

  it('smoke subset keeps one case per family', () => {
    const smoke = smokeSubset(dataset.cases);
    expect(smoke.length).toBe(new Set(dataset.cases.map((c) => c.family)).size);
  });
});

describe('benchmark metrics', () => {
  const pairs = [
    { expected: 'a', predicted: 'a' },
    { expected: 'a', predicted: 'b' },
    { expected: 'b', predicted: 'b' },
  ];
  it('computes accuracy and macro-F1', () => {
    expect(accuracy(pairs)).toBeCloseTo(2 / 3);
    // a: P=1 R=0.5 F1=0.667; b: P=0.5 R=1 F1=0.667
    expect(macroF1(pairs)).toBeCloseTo(2 / 3);
    expect(accuracy([])).toBeNull();
  });
  it('computes nearest-rank percentiles and retrieval metrics', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    const rankings = [
      { ranked: ['x', 'rel'], relevant: ['rel'] },
      { ranked: ['y', 'z'], relevant: ['rel'] },
    ];
    expect(recallAtK(rankings, 1)).toBe(0);
    expect(recallAtK(rankings, 2)).toBe(0.5);
    expect(meanReciprocalRank(rankings)).toBe(0.25);
  });
});

describe('real-model guard', () => {
  it('rejects stub, unreachable and disabled backends and unpulled models', () => {
    expect(() => assertRealModel({ backend: 'stub', modelInstalled: null })).toThrow(/stub/);
    expect(() => assertRealModel({ backend: 'unreachable', modelInstalled: null })).toThrow();
    expect(() => assertRealModel({ backend: 'disabled', modelInstalled: null })).toThrow();
    expect(() => assertRealModel({ backend: 'real', modelInstalled: false })).toThrow(/pulled/);
    expect(() => assertRealModel({ backend: 'real', modelInstalled: true })).not.toThrow();
  });
});

describe('benchmark runner', () => {
  it('deterministic config records decisions without model cost', async () => {
    const outcomes = await Promise.all(
      dataset.cases.map((c) => runCase(c, 'deterministic', 0, baseOptions))
    );
    expect(outcomes.every((o) => o.status === 'ok' && o.cost.modelCalls === 0)).toBe(true);
    const summary = summarize('deterministic', outcomes);
    expect(summary.agent).toBeNull();
    expect(summary.decision.byTrack.ci.n + summary.decision.byTrack.soc.n).toBe(
      dataset.cases.length
    );
  });

  const ciCase = dataset.cases.find((c) => c.id === 'ci-regress-assert-01') as CiCase;

  function scriptedClient(messages: Message[]): InvestigationModel {
    let index = 0;
    return {
      chat: async () =>
        ({
          message: messages[Math.min(index++, messages.length - 1)],
          prompt_eval_count: 100,
          eval_count: 20,
        }) as never,
    };
  }

  it('measures an agent run: action policy, unsupported claims, tokens', async () => {
    const report = (summary: string, extra: Record<string, unknown> = {}): Message => ({
      role: 'assistant',
      content: JSON.stringify({ summary, findings: [summary], confidence: 0.7, ...extra }),
    });
    const client = scriptedClient([
      report('triage'),
      report('repository'),
      report('action', { proposedAction: 'create_issue', risk: 'low' }),
      {
        role: 'assistant',
        content: JSON.stringify({
          suspectedRootCause: 'Order endpoint returns 500',
          evidence: ['Same as AUTO-999 seen last week'],
          recommendedAction: 'create_issue',
          confidence: 0.8,
          explanation: 'New server error on POST /api/orders',
        }),
      },
    ]);
    const outcome = await runCase(ciCase, 'multi_agent', 0, {
      ...baseOptions,
      client,
      model: 'test-model',
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.agent?.actionAcceptable).toBe(true);
    // AUTO-999 is not in the case input, so it is an unsupported claim.
    expect(outcome.agent?.unsupportedClaims).toEqual(['jira:AUTO-999']);
    expect(outcome.cost.modelCalls).toBe(4);
    expect(outcome.cost.promptTokens).toBe(400);
  });

  it('records a model error as a failure, never an exclusion', async () => {
    const client: InvestigationModel = {
      chat: async () => {
        throw new Error('connection reset');
      },
    };
    const outcome = await runCase(ciCase, 'single_agent', 0, {
      ...baseOptions,
      client,
      model: 'test-model',
    });
    expect(outcome.status).toBe('error');
    const summary = summarize('single_agent', [outcome]);
    expect(summary.agent?.failureRate).toBe(1);
    expect(summary.agent?.applicable).toBe(1);
  });

  it('marks cases production would not investigate as not applicable', async () => {
    const recovery = dataset.cases.find((c) => c.id === 'ci-recovery-01')!;
    const outcome = await runCase(recovery, 'multi_agent', 0, {
      ...baseOptions,
      client: scriptedClient([]),
      model: 'test-model',
    });
    expect(outcome.status).toBe('not_applicable');
  });
});
