import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  createSqsQueue,
  getInvestigationQueue,
  parseInvestigationMessage,
  resetInvestigationQueue,
} from '../services/investigation-queue';
import { processMessage } from '../workers/investigation-worker';
import { sslConfig } from '../db/client';

describe('investigation queue', () => {
  afterEach(() => {
    delete process.env.INVESTIGATION_QUEUE;
    delete process.env.INVESTIGATION_QUEUE_URL;
    resetInvestigationQueue();
  });

  it('sends only the alert id to SQS', async () => {
    const send = vi.fn(async () => ({}));
    await createSqsQueue('https://sqs.eu-west-1.amazonaws.com/1/q', { send } as never).enqueue(
      'a-1'
    );
    const command = (send.mock.calls[0] as unknown[])[0] as SendMessageCommand;
    expect(command.input.QueueUrl).toBe('https://sqs.eu-west-1.amazonaws.com/1/q');
    expect(JSON.parse(command.input.MessageBody!)).toMatchObject({ alertId: 'a-1' });
  });

  it('defaults to in-process and refuses sqs mode without a queue url', () => {
    expect(getInvestigationQueue()).toBeNull();
    resetInvestigationQueue();
    process.env.INVESTIGATION_QUEUE = 'sqs';
    expect(getInvestigationQueue()).toBeNull();
    resetInvestigationQueue();
    process.env.INVESTIGATION_QUEUE_URL = 'https://sqs.example/q';
    expect(getInvestigationQueue()?.kind).toBe('sqs');
  });

  it('parses messages defensively', () => {
    expect(parseInvestigationMessage('{"alertId":"a","enqueuedAt":"t"}')).toEqual({
      alertId: 'a',
      enqueuedAt: 't',
    });
    for (const bad of [undefined, '', 'not json', '{"alertId":""}', '{"alertId":5}']) {
      expect(parseInvestigationMessage(bad)).toBeNull();
    }
  });
});

describe('investigation worker processMessage (at-least-once semantics)', () => {
  const input = { alert: {}, triage: {}, enrichment: null, result: {} } as never;
  const body = JSON.stringify({ alertId: 'a-1' });

  it('completes and lets the message be deleted', async () => {
    const run = vi.fn(async () => ({ status: 'completed' as const }));
    const load = vi.fn(async () => ({ input, alreadyCompleted: false }));
    expect(await processMessage(body, { load, run })).toBe('completed');
    expect(load).toHaveBeenCalledWith('a-1');
  });

  it('asks for a retry when the investigation fails (eventually dead-lettered)', async () => {
    expect(
      await processMessage(body, {
        load: async () => ({ input, alreadyCompleted: false }),
        run: async () => ({ status: 'failed' }),
      })
    ).toBe('retry');
  });

  it('is idempotent on redelivery of completed work', async () => {
    const run = vi.fn();
    expect(
      await processMessage(body, { load: async () => ({ input, alreadyCompleted: true }), run })
    ).toBe('skipped_completed');
    expect(run).not.toHaveBeenCalled();
  });

  it('discards poison messages and alerts that no longer exist', async () => {
    const deps = { load: async () => ({ input: null, alreadyCompleted: false }), run: vi.fn() };
    expect(await processMessage('garbage', deps)).toBe('discarded');
    expect(await processMessage(body, deps)).toBe('discarded');
    expect(deps.run).not.toHaveBeenCalled();
  });
});

describe('sslConfig (RDS TLS)', () => {
  it('is off unless DB_SSL=require', () => {
    expect(sslConfig({})).toBeUndefined();
  });

  it('verifies certificates against the configured CA bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-'));
    writeFileSync(join(dir, 'ca.pem'), 'PEM');
    expect(sslConfig({ DB_SSL: 'require', DB_SSL_CA_FILE: join(dir, 'ca.pem') })).toEqual({
      rejectUnauthorized: true,
      ca: 'PEM',
    });
    expect(sslConfig({ DB_SSL: 'require' })).toEqual({ rejectUnauthorized: true });
  });
});

describe('runWorker loop', () => {
  it('deletes finished messages, backs off failed ones, and stops on abort', async () => {
    const { runWorker } = await import('../workers/investigation-worker');
    const controller = new AbortController();
    const sent: string[] = [];
    let polls = 0;
    const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name;
        sent.push(`${name}:${String(command.input.ReceiptHandle ?? '')}`);
        if (name === 'ReceiveMessageCommand') {
          polls++;
          if (polls > 1) controller.abort();
          return polls === 1
            ? {
                Messages: [
                  {
                    MessageId: '1',
                    ReceiptHandle: 'ok',
                    Body: JSON.stringify({ alertId: 'good' }),
                  },
                  {
                    MessageId: '2',
                    ReceiptHandle: 'bad',
                    Body: JSON.stringify({ alertId: 'flaky' }),
                  },
                ],
              }
            : { Messages: [] };
        }
        return {};
      },
    };
    const input = {} as never;
    await runWorker({
      queueUrl: 'q',
      client: client as never,
      signal: controller.signal,
      deps: {
        load: async () => ({ input, alreadyCompleted: false }),
        run: vi
          .fn()
          .mockResolvedValueOnce({ status: 'completed' })
          .mockResolvedValueOnce({ status: 'failed' }),
      },
    });
    expect(sent).toEqual([
      'ReceiveMessageCommand:',
      'DeleteMessageCommand:ok',
      'ChangeMessageVisibilityCommand:bad',
      'ReceiveMessageCommand:',
    ]);
  });
});

describe('runWorker shutdown', () => {
  it('does not wait out the receive-error backoff once aborted', async () => {
    const { runWorker } = await import('../workers/investigation-worker');
    const controller = new AbortController();
    const client = {
      async send() {
        setTimeout(() => controller.abort(), 10);
        throw new Error('InvalidClientTokenId');
      },
    };
    const started = Date.now();
    await runWorker({ queueUrl: 'q', client: client as never, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(1_000); // backoff is 5s when not aborted
  });
});
