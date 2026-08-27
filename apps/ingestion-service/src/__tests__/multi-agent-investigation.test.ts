import { afterEach, describe, expect, it } from 'vitest';
import { Command, MemorySaver, isInterrupted } from '@langchain/langgraph';
import type { Message } from 'ollama';
import type { InvestigationContext, InvestigationModel } from '../services/failure-investigation-agent';
import { createMultiAgentInvestigationGraph, runMultiAgentInvestigation } from '../services/multi-agent-investigation';

const context = {
  test: { testId: 'webhook::secret', title: 'accepts matching webhook secret', suite: 'Security', file: 'webhook.spec.ts', status: 'failed', durationMs: 80, retry: 0, error: { name: 'AssertionError', message: 'Expected 201, received 401' }, metadata: { service: 'ingestion-service' } },
  run: { schemaVersion: '1.0.0', runId: 'multi-run-1', repository: 'orchestrator', branch: 'main', commitSha: 'abc123', environment: 'staging', triggeredBy: 'test', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', summary: { total: 1, passed: 0, failed: 1, skipped: 0 }, tests: [] },
  fingerprint: 'multi-fingerprint-1', deterministicClassification: 'new_regression', history: null, existingIssue: null,
} satisfies InvestigationContext;

const specialist = (summary: string): Message => ({
  role: 'assistant',
  content: JSON.stringify({ summary, findings: [`${summary} finding`], confidence: 0.82 }),
});

const action: Message = {
  role: 'assistant',
  content: JSON.stringify({ summary: 'Review the authentication regression', findings: ['A security-sensitive path changed'], confidence: 0.86, proposedAction: 'human_review', risk: 'high' }),
};

const final: Message = {
  role: 'assistant',
  content: JSON.stringify({ suspectedRootCause: 'Webhook validation mismatch', evidence: ['Triage and repository evidence converge'], recommendedAction: 'human_review', confidence: 0.84, explanation: 'A reviewer should validate the security-sensitive fix.' }),
};

afterEach(() => {
  delete process.env.RAG_ENABLED;
});

describe('multi-agent investigation supervisor', () => {
  it('coordinates specialists, repository retrieval, and supervisor synthesis', async () => {
    process.env.RAG_ENABLED = 'true';
    const responses = [specialist('Triage report'), specialist('Repository report'), action, final];
    const prompts: Message[][] = [];
    const events: Array<{ node: string; status: string }> = [];
    const metrics: Array<{ node: string; promptVersion: string; promptTokens: number; completionTokens: number }> = [];
    const client: InvestigationModel = {
      async chat(input) {
        prompts.push(input.messages);
        return { message: responses.shift()!, prompt_eval_count: 120, eval_count: 40 };
      },
    };

    const result = await runMultiAgentInvestigation(context, client, 'qwen-test', {
      knowledgeSearch: async () => [{ sourcePath: 'apps/ingestion-service/src/middleware/webhook-secret.ts', chunkIndex: 0, content: 'timingSafeEqual', score: 0.93 }],
      audit: { async record(event) { events.push({ node: event.node, status: event.status }); } },
      telemetry: { async recordModelCall(metric) { metrics.push(metric); } },
    });

    expect(prompts).toHaveLength(4);
    expect(result?.orchestration).toBe('supervisor');
    expect(result?.specialistReports?.map((report) => report.agent)).toEqual(['triage', 'repository', 'action']);
    expect(result?.toolsUsed).toEqual(['search_repository_context']);
    expect(result?.sources).toEqual([{ path: 'apps/ingestion-service/src/middleware/webhook-secret.ts', chunk: 0, score: 0.93 }]);
    expect(events.filter((event) => event.status === 'completed').map((event) => event.node)).toEqual([
      'agent:triage', 'agent:repository', 'agent:action', 'supervisor',
    ]);
    expect(metrics.map((metric) => metric.promptVersion)).toEqual([
      'triage-v1', 'repository-v1', 'action-policy-v1', 'supervisor-v1',
    ]);
    expect(metrics.every((metric) => metric.promptTokens === 120 && metric.completionTokens === 40)).toBe(true);
  });

  it('pauses and resumes the supervisor result without rerunning workers', async () => {
    const checkpointer = new MemorySaver();
    const responses = [specialist('Triage report'), specialist('Repository report'), action, final];
    let calls = 0;
    const client: InvestigationModel = { async chat() { calls += 1; return { message: responses.shift()! }; } };
    const graph = createMultiAgentInvestigationGraph(client, { checkpointer, requireApproval: true });
    const config = { configurable: { thread_id: 'multi-approval-1' } };
    const paused = await graph.invoke({ context, model: 'qwen-test', reports: [], toolsUsed: [], sources: [], result: undefined, approvalStatus: 'not_required' }, config);

    expect(isInterrupted(paused)).toBe(true);
    const resumed = await graph.invoke(new Command({ resume: { approved: true, reviewer: 'vitest' } }), config);
    expect(resumed.approvalStatus).toBe('approved');
    expect(calls).toBe(4);
  });
});
