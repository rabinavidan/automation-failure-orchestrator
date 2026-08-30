import { describe, expect, it } from 'vitest';
import type { AgentInvestigation } from '@orchestrator/shared-types';
import { evaluateAgentInvestigation } from '../services/agent-evaluation';
import type { JudgeResult } from '../services/agent-judge';
import type { InvestigationModel } from '../services/failure-investigation-agent';
import {
  buildFailureModeReport,
  classifyFailureModes,
  sampleProductionFailureModes,
  type ExecutionFetcher,
  type ExecutionRecord,
  type FailureModeSample,
} from '../services/failure-mode-taxonomy';

const cleanInvestigation: AgentInvestigation = {
  suspectedRootCause: 'Payment gateway outage',
  evidence: ['The server error reports the payment gateway is unavailable'],
  recommendedAction: 'notify_only',
  confidence: 0.8,
  explanation: 'Transient external dependency failure.',
  toolsUsed: ['get_failure_history'],
  model: 'qwen3:4b',
};

const unsafeInvestigation: AgentInvestigation = {
  ...cleanInvestigation,
  confidence: 1.4,
  recommendedAction: 'create_issue',
  specialistReports: [
    {
      agent: 'action',
      summary: 'High risk change',
      findings: ['security path touched'],
      confidence: 0.9,
      proposedAction: 'create_issue',
      risk: 'high',
    },
  ],
};

const record = (
  threadId: string,
  finalResult: AgentInvestigation,
  overrides: Partial<ExecutionRecord> = {}
): ExecutionRecord => ({
  threadId,
  runId: `run-${threadId}`,
  fingerprint: `fp-${threadId}`,
  testId: `test-${threadId}`,
  model: 'qwen3:4b',
  finalResult,
  ...overrides,
});

describe('classifyFailureModes', () => {
  it('returns no failure modes for a clean, well-formed investigation', () => {
    const deterministic = evaluateAgentInvestigation(cleanInvestigation);
    expect(classifyFailureModes(cleanInvestigation, deterministic)).toEqual([]);
  });

  it('flags unsafe high-risk policy and out-of-range confidence together', () => {
    const deterministic = evaluateAgentInvestigation(unsafeInvestigation);
    const modes = classifyFailureModes(unsafeInvestigation, deterministic);
    expect(modes).toContain('unsafe_high_risk_policy');
    expect(modes).toContain('confidence_out_of_range');
  });

  it('flags ungrounded_rag when RAG is expected but no citations were used', () => {
    const deterministic = evaluateAgentInvestigation(cleanInvestigation, { ragExpected: true });
    expect(classifyFailureModes(cleanInvestigation, deterministic)).toContain('ungrounded_rag');
  });

  it('adds judge-derived failure modes for low-scoring dimensions', () => {
    const deterministic = evaluateAgentInvestigation(cleanInvestigation);
    const judge: JudgeResult = {
      ok: true,
      verdict: {
        groundedness: 0.2,
        rootCauseQuality: 0.9,
        explanationClarity: 0.3,
        verdict: 'fail',
        rationale: 'Weak evidence linkage.',
      },
    };
    const modes = classifyFailureModes(cleanInvestigation, deterministic, judge);
    expect(modes).toEqual(expect.arrayContaining(['low_groundedness', 'low_explanation_clarity']));
    expect(modes).not.toContain('low_root_cause_quality');
  });

  it('flags judge_unavailable when the judge call failed', () => {
    const deterministic = evaluateAgentInvestigation(cleanInvestigation);
    const judge: JudgeResult = { ok: false, error: 'timeout' };
    expect(classifyFailureModes(cleanInvestigation, deterministic, judge)).toEqual([
      'judge_unavailable',
    ]);
  });

  it('flags overconfident_language when absolute phrasing outpaces stated confidence', () => {
    const overconfident: AgentInvestigation = {
      ...cleanInvestigation,
      confidence: 0.6,
      explanation: 'This is definitely a payment gateway outage.',
    };
    const deterministic = evaluateAgentInvestigation(overconfident);
    expect(classifyFailureModes(overconfident, deterministic)).toContain('overconfident_language');
  });

  it('flags excessive_hedging when the explanation is hedge-laden', () => {
    const hedgy: AgentInvestigation = {
      ...cleanInvestigation,
      explanation:
        'It might be the gateway, or maybe a config issue, possibly related to retries, though it could be something else.',
    };
    const deterministic = evaluateAgentInvestigation(hedgy);
    expect(classifyFailureModes(hedgy, deterministic)).toContain('excessive_hedging');
  });
});

describe('buildFailureModeReport', () => {
  it('aggregates counts and caps examples per failure mode', () => {
    const samples: FailureModeSample[] = [
      { threadId: 't1', testId: 'a', fingerprint: 'f1', modes: [] },
      { threadId: 't2', testId: 'b', fingerprint: 'f2', modes: ['confidence_out_of_range'] },
      { threadId: 't3', testId: 'c', fingerprint: 'f3', modes: ['confidence_out_of_range'] },
      { threadId: 't4', testId: 'd', fingerprint: 'f4', modes: ['confidence_out_of_range'] },
    ];
    const report = buildFailureModeReport(samples, 2);
    expect(report.sampleSize).toBe(4);
    expect(report.cleanCount).toBe(1);
    expect(report.modeCounts.confidence_out_of_range).toBe(3);
    expect(report.examples.confidence_out_of_range).toEqual(['t2', 't3']);
    expect(report.modeCounts.schema_incomplete).toBe(0);
  });
});

describe('sampleProductionFailureModes', () => {
  it('fetches, evaluates, and reports across records without a judge client', async () => {
    const fetcher: ExecutionFetcher = {
      fetchRecentCompleted: async () => [
        record('t1', cleanInvestigation),
        record('t2', unsafeInvestigation),
      ],
    };
    const report = await sampleProductionFailureModes(fetcher, { limit: 10 });
    expect(report.sampleSize).toBe(2);
    expect(report.cleanCount).toBe(1);
    expect(report.modeCounts.unsafe_high_risk_policy).toBe(1);
  });

  it('runs the judge per record when a judge client is provided', async () => {
    const fetcher: ExecutionFetcher = {
      fetchRecentCompleted: async () => [record('t1', cleanInvestigation)],
    };
    const judgeClient: InvestigationModel = {
      chat: async () => ({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            groundedness: 0.1,
            rootCauseQuality: 0.9,
            explanationClarity: 0.9,
            verdict: 'fail',
            rationale: 'Evidence is thin.',
          }),
        },
      }),
    };
    const report = await sampleProductionFailureModes(fetcher, {
      limit: 10,
      judgeClient,
      judgeModel: 'qwen3:4b',
    });
    expect(report.modeCounts.low_groundedness).toBe(1);
    expect(report.cleanCount).toBe(0);
  });
});
