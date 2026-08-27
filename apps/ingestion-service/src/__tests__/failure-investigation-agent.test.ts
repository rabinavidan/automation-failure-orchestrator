import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import type { Message } from 'ollama';
import { runFailureInvestigationGraph } from '../services/failure-investigation-agent';
import type { InvestigationContext, InvestigationModel } from '../services/failure-investigation-agent';

const context = {
  test: { testId: 'checkout::payment', title: 'processes a payment', suite: 'Checkout', file: 'checkout.spec.ts', status: 'failed', durationMs: 100, retry: 0, error: { name: 'Error', message: 'Payment gateway unavailable' } },
  run: { schemaVersion: '1.0.0', runId: 'run-1', repository: 'acme/tests', branch: 'main', commitSha: 'abc123', environment: 'staging', triggeredBy: 'test', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', summary: { total: 1, passed: 0, failed: 1, skipped: 0 }, tests: [] },
  fingerprint: 'fingerprint-1', deterministicClassification: 'flaky',
  history: { fingerprint: 'fingerprint-1', runCount: 4, lastStatuses: ['failed', 'passed'], consecutivePasses: 1 }, existingIssue: null,
} satisfies InvestigationContext;

const finalMessage: Message = { role: 'assistant', content: JSON.stringify({ suspectedRootCause: 'Transient payment gateway outage', evidence: ['The dependency was unavailable', 'The failure is intermittent'], recommendedAction: 'notify_only', confidence: 0.9, explanation: 'Retry first and escalate if the outage persists.' }) };

describe('failure investigation LangGraph', () => {
  it('routes tool calls back into reasoning and returns validated output', async () => {
    const requests: Message[][] = [];
    const responses: Message[] = [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_failure_history', arguments: {} } }] }, finalMessage];
    const client: InvestigationModel = { async chat(input) { requests.push(input.messages); return { message: responses.shift()! }; } };
    const result = await runFailureInvestigationGraph(context, client, 'test-model');
    expect(result?.suspectedRootCause).toBe('Transient payment gateway outage');
    expect(result?.toolsUsed).toEqual(['get_failure_history']);
    expect(result?.model).toBe('test-model');
    expect(requests).toHaveLength(2);
    expect(requests[1].at(-1)).toMatchObject({ role: 'tool', tool_name: 'get_failure_history' });
    expect(requests[1].at(-1)?.content).toContain('fingerprint-1');
  });

  it('finishes without tools when the model has enough evidence', async () => {
    const client: InvestigationModel = { async chat() { return { message: finalMessage }; } };
    const result = await runFailureInvestigationGraph(context, client, 'test-model');
    expect(result?.toolsUsed).toEqual([]);
    expect(result?.recommendedAction).toBe('notify_only');
  });

  it('stops after the bounded number of reasoning steps', async () => {
    let calls = 0;
    const client: InvestigationModel = { async chat() { calls += 1; return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_related_jira_issue', arguments: {} } }] } }; } };
    const result = await runFailureInvestigationGraph(context, client, 'test-model');
    expect(result).toBeUndefined();
    expect(calls).toBe(3);
  });

  it('persists graph checkpoints and emits an auditable node timeline', async () => {
    const checkpointer = new MemorySaver();
    const events: Array<{ node: string; status: string }> = [];
    const client: InvestigationModel = { async chat() { return { message: finalMessage }; } };

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
});
