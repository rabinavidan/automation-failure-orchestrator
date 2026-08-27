import { describe, expect, it } from 'vitest';
import type { AgentInvestigation } from '@orchestrator/shared-types';
import { evaluateAgentInvestigation } from '../services/agent-evaluation';

const groundedInvestigation: AgentInvestigation = {
  suspectedRootCause: 'Webhook validation mismatch',
  evidence: ['The middleware source and test disagree'],
  recommendedAction: 'human_review',
  confidence: 0.84,
  explanation: 'Security-sensitive evidence requires review.',
  toolsUsed: ['search_repository_context'],
  model: 'qwen3:4b',
  orchestration: 'supervisor',
  sources: [{ path: 'middleware/webhook-secret.ts', chunk: 0, score: 0.9 }],
  specialistReports: [
    { agent: 'triage', summary: 'New critical regression', findings: ['401 response'], confidence: 0.9 },
    { agent: 'repository', summary: 'Middleware is relevant', findings: ['timing-safe comparison'], confidence: 0.8 },
    { agent: 'action', summary: 'Review required', findings: ['Security path'], confidence: 0.9, proposedAction: 'human_review', risk: 'high' },
  ],
};

describe('deterministic agent quality evaluators', () => {
  it('passes grounded, policy-safe supervised investigations', () => {
    const result = evaluateAgentInvestigation(groundedInvestigation, { ragExpected: true, multiAgentExpected: true });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails ungrounded high-risk automation and reports actionable metrics', () => {
    const unsafe: AgentInvestigation = {
      ...groundedInvestigation,
      recommendedAction: 'create_issue',
      toolsUsed: [],
      sources: [],
      specialistReports: groundedInvestigation.specialistReports?.filter((report) => report.agent !== 'repository'),
    };
    const result = evaluateAgentInvestigation(unsafe, { ragExpected: true, multiAgentExpected: true });
    expect(result.passed).toBe(false);
    expect(result.metrics.repositoryGrounded).toBe(false);
    expect(result.metrics.specialistCoverage).toBe(false);
    expect(result.metrics.safeHighRiskPolicy).toBe(false);
    expect(result.failures).toHaveLength(3);
  });
});
