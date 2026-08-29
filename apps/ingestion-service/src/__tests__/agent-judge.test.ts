import { describe, expect, it } from 'vitest';
import type { AgentInvestigation } from '@orchestrator/shared-types';
import type { InvestigationModel } from '../services/failure-investigation-agent';
import { judgeInvestigation, scoreJudgeAgreement } from '../services/agent-judge';
import { JUDGE_LABELED_SET } from '../services/judge-labeled-set';

const investigation: AgentInvestigation = {
  suspectedRootCause: 'Webhook signature comparison uses non-timing-safe equality',
  evidence: ['middleware/webhook-secret.ts compares secrets with ==='],
  recommendedAction: 'human_review',
  confidence: 0.84,
  explanation: 'Security-sensitive pattern warrants human review.',
  toolsUsed: ['search_repository_context'],
  model: 'qwen3:4b',
};

const fixedVerdictClient = (content: string): InvestigationModel => ({
  chat: async () => ({ message: { role: 'assistant', content } }),
});

const passVerdict = JSON.stringify({
  groundedness: 0.9,
  rootCauseQuality: 0.85,
  explanationClarity: 0.8,
  verdict: 'pass',
  rationale: 'Evidence supports the stated root cause.',
});

const failVerdict = JSON.stringify({
  groundedness: 0.2,
  rootCauseQuality: 0.3,
  explanationClarity: 0.4,
  verdict: 'fail',
  rationale: 'Evidence does not support the stated root cause.',
});

describe('judgeInvestigation', () => {
  it('returns a validated verdict for well-formed judge output', async () => {
    const result = await judgeInvestigation(
      investigation,
      fixedVerdictClient(passVerdict),
      'qwen3:4b'
    );
    expect(result.ok).toBe(true);
    expect(result.verdict?.verdict).toBe('pass');
    expect(result.verdict?.groundedness).toBeGreaterThanOrEqual(0);
    expect(result.verdict?.groundedness).toBeLessThanOrEqual(1);
  });

  it('fails closed when judge output is not valid JSON', async () => {
    const result = await judgeInvestigation(
      investigation,
      fixedVerdictClient('not json'),
      'qwen3:4b'
    );
    expect(result.ok).toBe(false);
    expect(result.verdict).toBeUndefined();
    expect(result.error).toMatch(/not valid JSON/);
  });

  it('fails closed when judge output violates the schema', async () => {
    const malformed = JSON.stringify({ verdict: 'pass' });
    const result = await judgeInvestigation(
      investigation,
      fixedVerdictClient(malformed),
      'qwen3:4b'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schema validation/);
  });

  it('fails closed when the model call throws', async () => {
    const throwingClient: InvestigationModel = {
      chat: async () => {
        throw new Error('timeout');
      },
    };
    const result = await judgeInvestigation(investigation, throwingClient, 'qwen3:4b');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });
});

describe('scoreJudgeAgreement', () => {
  it('reports full agreement when the judge matches every human label', async () => {
    const client: InvestigationModel = {
      chat: async (input) => {
        const userMessage = input.messages.find((m) => m.role === 'user');
        const payload = JSON.parse(userMessage?.content ?? '{}');
        const example = JUDGE_LABELED_SET.find(
          (item) => item.investigation.suspectedRootCause === payload.suspectedRootCause
        );
        return {
          message: {
            role: 'assistant',
            content: example?.humanVerdict === 'pass' ? passVerdict : failVerdict,
          },
        };
      },
    };
    const report = await scoreJudgeAgreement(JUDGE_LABELED_SET, client, 'qwen3:4b');
    expect(report.total).toBe(JUDGE_LABELED_SET.length);
    expect(report.agreementRate).toBe(1);
    expect(report.disagreements).toHaveLength(0);
  });

  it('records disagreements and lowers the agreement rate when the judge is wrong', async () => {
    const alwaysPassClient = fixedVerdictClient(passVerdict);
    const report = await scoreJudgeAgreement(JUDGE_LABELED_SET, alwaysPassClient, 'qwen3:4b');
    const expectedFailures = JUDGE_LABELED_SET.filter((e) => e.humanVerdict === 'fail').length;
    expect(report.disagreements).toHaveLength(expectedFailures);
    expect(report.agreementRate).toBeLessThan(1);
    expect(report.agreementRate).toBeGreaterThan(0);
  });

  it('marks a disagreement as unavailable when the judge call fails', async () => {
    const brokenClient: InvestigationModel = {
      chat: async () => {
        throw new Error('unreachable');
      },
    };
    const report = await scoreJudgeAgreement(JUDGE_LABELED_SET, brokenClient, 'qwen3:4b');
    expect(report.agreementRate).toBe(0);
    expect(report.disagreements.every((d) => d.judgeVerdict === 'unavailable')).toBe(true);
  });
});
