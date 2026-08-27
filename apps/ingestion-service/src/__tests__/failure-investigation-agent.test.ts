import { describe, expect, it } from 'vitest';
import { Command, MemorySaver, isInterrupted } from '@langchain/langgraph';
import type { Message } from 'ollama';
import {
  createFailureInvestigationGraph,
  runFailureInvestigationGraph,
} from '../services/failure-investigation-agent';
import type {
  InvestigationContext,
  InvestigationModel,
} from '../services/failure-investigation-agent';

const context = {
  test: {
    testId: 'checkout::payment',
    title: 'processes a payment',
    suite: 'Checkout',
    file: 'checkout.spec.ts',
    status: 'failed',
    durationMs: 100,
    retry: 0,
    error: { name: 'Error', message: 'Payment gateway unavailable' },
  },
  run: {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    repository: 'acme/tests',
    branch: 'main',
    commitSha: 'abc123',
    environment: 'staging',
    triggeredBy: 'test',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
    summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
    tests: [],
  },
  fingerprint: 'fingerprint-1',
  deterministicClassification: 'flaky',
  history: {
    fingerprint: 'fingerprint-1',
    runCount: 4,
    lastStatuses: ['failed', 'passed'],
    consecutivePasses: 1,
  },
  existingIssue: null,
} satisfies InvestigationContext;

const finalMessage: Message = {
  role: 'assistant',
  content: JSON.stringify({
    suspectedRootCause: 'Transient payment gateway outage',
    evidence: ['The dependency was unavailable', 'The failure is intermittent'],
    recommendedAction: 'notify_only',
    confidence: 0.9,
    explanation: 'Retry first and escalate if the outage persists.',
  }),
};

describe('failure investigation LangGraph', () => {
  it('routes tool calls back into reasoning and returns validated output', async () => {
    const requests: Message[][] = [];
    const responses: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_failure_history', arguments: {} } }],
      },
      finalMessage,
    ];
    const client: InvestigationModel = {
      async chat(input) {
        requests.push(input.messages);
        return { message: responses.shift()! };
      },
    };
    const result = await runFailureInvestigationGraph(context, client, 'test-model');
    expect(result?.suspectedRootCause).toBe('Transient payment gateway outage');
    expect(result?.toolsUsed).toEqual(['get_failure_history']);
    expect(result?.model).toBe('test-model');
    expect(requests).toHaveLength(2);
    expect(requests[1].at(-1)).toMatchObject({ role: 'tool', tool_name: 'get_failure_history' });
    expect(requests[1].at(-1)?.content).toContain('fingerprint-1');
  });

  it('finishes without tools when the model has enough evidence', async () => {
    const client: InvestigationModel = {
      async chat() {
        return { message: finalMessage };
      },
    };
    const result = await runFailureInvestigationGraph(context, client, 'test-model');
    expect(result?.toolsUsed).toEqual([]);
    expect(result?.recommendedAction).toBe('notify_only');
  });

  it('adds cited repository sources returned by the bounded RAG tool', async () => {
    const previousRagEnabled = process.env.RAG_ENABLED;
    process.env.RAG_ENABLED = 'true';
    const responses: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'search_repository_context',
              arguments: { query: 'webhook validation' },
            },
          },
        ],
      },
      finalMessage,
    ];
    const client: InvestigationModel = {
      async chat() {
        return { message: responses.shift()! };
      },
    };
    try {
      const result = await runFailureInvestigationGraph(context, client, 'test-model', {
        knowledgeSearch: async () => [
          {
            sourcePath: 'docs/api.md',
            chunkIndex: 2,
            content: 'Webhook payloads are validated with Zod.',
            score: 0.91,
          },
        ],
      });
      expect(result?.toolsUsed).toEqual(['search_repository_context']);
      expect(result?.sources).toEqual([{ path: 'docs/api.md', chunk: 2, score: 0.91 }]);
    } finally {
      process.env.RAG_ENABLED = previousRagEnabled;
    }
  });

  it('stops after the bounded number of reasoning steps', async () => {
    let calls = 0;
    const client: InvestigationModel = {
      async chat() {
        calls += 1;
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'get_related_jira_issue', arguments: {} } }],
          },
        };
      },
    };
    const result = await runFailureInvestigationGraph(context, client, 'test-model');
    expect(result).toBeUndefined();
    expect(calls).toBe(5);
  });

  it('persists graph checkpoints and emits an auditable node timeline', async () => {
    const checkpointer = new MemorySaver();
    const events: Array<{ node: string; status: string }> = [];
    const client: InvestigationModel = {
      async chat() {
        return { message: finalMessage };
      },
    };

    await runFailureInvestigationGraph(context, client, 'test-model', {
      checkpointer,
      threadId: 'run-1:fingerprint-1',
      audit: {
        async record(event) {
          events.push({ node: event.node, status: event.status });
        },
      },
    });

    const checkpoints = [];
    for await (const checkpoint of checkpointer.list({
      configurable: { thread_id: 'run-1:fingerprint-1' },
    })) {
      checkpoints.push(checkpoint);
    }

    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(events).toEqual([
      { node: 'reason', status: 'started' },
      { node: 'reason', status: 'completed' },
    ]);
  });

  it.each([
    [true, 'approved'],
    [false, 'rejected'],
  ] as const)('interrupts for human review and resumes as %s', async (approved, expected) => {
    const checkpointer = new MemorySaver();
    const humanReviewMessage: Message = {
      role: 'assistant',
      content: JSON.stringify({
        suspectedRootCause: 'Evidence is inconclusive',
        evidence: ['No matching history'],
        recommendedAction: 'human_review',
        confidence: 0.45,
        explanation: 'A person should validate the proposed action.',
      }),
    };
    let modelCalls = 0;
    const client: InvestigationModel = {
      async chat() {
        modelCalls += 1;
        return { message: humanReviewMessage };
      },
    };
    const graph = createFailureInvestigationGraph(client, {
      checkpointer,
      threadId: `approval-${approved}`,
      requireApproval: true,
    });
    const config = { configurable: { thread_id: `approval-${approved}` } };
    const paused = await graph.invoke(
      {
        context,
        model: 'test-model',
        messages: [],
        pendingCalls: [],
        toolsUsed: [],
        reasoningSteps: 0,
        result: undefined,
        approvalStatus: 'not_required',
      },
      config
    );

    expect(isInterrupted(paused)).toBe(true);
    const resumed = await graph.invoke(
      new Command({ resume: { approved, reviewer: 'vitest' } }),
      config
    );
    expect(resumed.approvalStatus).toBe(expected);
    expect(modelCalls).toBe(1);
  });
});
