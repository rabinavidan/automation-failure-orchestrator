import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AlertProcessingResult } from '@orchestrator/shared-types';
import type { InvestigationModel } from '../services/failure-investigation-agent';
import { runAlertInvestigation, scheduleAlertInvestigation } from '../services/alert-investigation';
import { socAlert, socEnrichment, socTriage, scriptedResponses } from './fixtures/soc-alert';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client', () => ({ query }));

const result: AlertProcessingResult = {
  alertId: socAlert.alertId,
  fingerprint: 'f'.repeat(64),
  fingerprintLabel: 'l',
  status: 'new',
  occurrenceCount: 1,
  suppressedCount: 0,
  firstSeenAt: '',
  lastSeenAt: '',
};
const input = { alert: socAlert, result, triage: socTriage, enrichment: socEnrichment };

function client(contents: string[]): InvestigationModel {
  return {
    async chat() {
      return { message: { role: 'assistant', content: contents.shift()! } };
    },
  };
}

describe('scheduleAlertInvestigation', () => {
  const original = process.env.AI_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = original;
  });

  it('is disabled when AI is off', () => {
    delete process.env.AI_ENABLED;
    expect(scheduleAlertInvestigation(input, undefined, vi.fn(), null)).toEqual({
      status: 'disabled',
    });
  });

  it.each(['false_positive', 'duplicate', 'benign_true_positive'] as const)(
    'never spends model time on %s alerts',
    (disposition) => {
      process.env.AI_ENABLED = 'true';
      const schedule = vi.fn();
      expect(
        scheduleAlertInvestigation(
          { ...input, triage: { ...socTriage, disposition } },
          undefined,
          schedule,
          null
        )
      ).toEqual({ status: 'not_applicable' });
      expect(schedule).not.toHaveBeenCalled();
    }
  );

  it('queues true positives without blocking the webhook response', () => {
    process.env.AI_ENABLED = 'true';
    const schedule = vi.fn();
    expect(scheduleAlertInvestigation(input, undefined, schedule, null)).toEqual({
      status: 'queued',
      threadId: `alert:${socAlert.alertId}`,
      queue: 'in_process',
    });
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('hands work to the durable queue when configured, without running in-process', async () => {
    process.env.AI_ENABLED = 'true';
    const schedule = vi.fn();
    const queue = { kind: 'sqs' as const, enqueue: vi.fn(async () => undefined) };
    expect(scheduleAlertInvestigation(input, undefined, schedule, queue)).toMatchObject({
      status: 'queued',
      queue: 'sqs',
    });
    await Promise.resolve();
    expect(queue.enqueue).toHaveBeenCalledWith(socAlert.alertId);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('falls back to in-process when the enqueue fails', async () => {
    process.env.AI_ENABLED = 'true';
    const schedule = vi.fn();
    const queue = {
      kind: 'sqs' as const,
      enqueue: vi.fn(async () => {
        throw new Error('AccessDenied');
      }),
    };
    scheduleAlertInvestigation(input, undefined, schedule, queue);
    await new Promise((resolve) => setImmediate(resolve));
    expect(schedule).toHaveBeenCalledOnce();
  });
});

describe('runAlertInvestigation', () => {
  beforeEach(() => query.mockReset());

  it('persists a completed, evaluated investigation and audit trail', async () => {
    const outcome = await runAlertInvestigation(input, {
      client: client(scriptedResponses()),
      model: 'qwen-test',
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.evaluation?.failures).toEqual([]);
    const sql = query.mock.calls.map(([text]) => String(text));
    expect(sql.some((s) => s.includes('INSERT INTO agent_executions'))).toBe(true);
    expect(sql.some((s) => s.includes("ai_investigation_status = 'completed'"))).toBe(true);
    expect(sql.filter((s) => s.includes('INSERT INTO agent_model_calls'))).toHaveLength(4);
  });

  it('records evaluation failures for a hallucinated IOC instead of hiding them', async () => {
    const outcome = await runAlertInvestigation(input, {
      client: client(
        scriptedResponses({
          final: { responseSteps: ['Block 203.0.113.9 and 192.0.2.99 [approval]'] },
        })
      ),
      model: 'm',
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.evaluation?.passed).toBe(false);
    expect(outcome.evaluation?.ungroundedIndicators).toEqual(['192.0.2.99']);
  });

  it('fails open when the model is unavailable', async () => {
    const down: InvestigationModel = {
      async chat() {
        throw new Error('ECONNREFUSED');
      },
    };
    const outcome = await runAlertInvestigation(input, { client: down, model: 'm' });
    expect(outcome).toEqual({ status: 'failed' });
    const sql = query.mock.calls.map(([text, params]) => [String(text), params]);
    expect(
      sql.some(
        ([text, params]) =>
          (text as string).includes('ai_investigation_status = $2') &&
          (params as unknown[])[1] === 'failed'
      )
    ).toBe(true);
  });
});
