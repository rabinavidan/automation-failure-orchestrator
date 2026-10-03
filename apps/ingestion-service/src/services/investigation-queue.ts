import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

/**
 * Durable hand-off for advisory SOC investigations. Locally (default) work runs
 * in-process; on AWS (`INVESTIGATION_QUEUE=sqs`) the API only enqueues the alert id
 * and a separate worker consumes it, so restarts and deploys never lose queued work
 * and repeated failures land in a dead-letter queue.
 */
export interface InvestigationQueue {
  readonly kind: 'sqs';
  enqueue(alertId: string): Promise<void>;
}

export interface InvestigationMessage {
  alertId: string;
  enqueuedAt: string;
}

let cached: InvestigationQueue | null | undefined;

export function createSqsQueue(
  queueUrl: string,
  client: Pick<SQSClient, 'send'> = new SQSClient({})
) {
  return {
    kind: 'sqs' as const,
    async enqueue(alertId: string) {
      const body: InvestigationMessage = { alertId, enqueuedAt: new Date().toISOString() };
      await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) })
      );
    },
  };
}

/** Null means "run in-process". Misconfiguration is reported once and falls back safely. */
export function getInvestigationQueue(): InvestigationQueue | null {
  if (cached !== undefined) return cached;
  if (process.env.INVESTIGATION_QUEUE !== 'sqs') return (cached = null);
  const url = process.env.INVESTIGATION_QUEUE_URL;
  if (!url) {
    console.error(
      '[Queue] INVESTIGATION_QUEUE=sqs but INVESTIGATION_QUEUE_URL is unset; using in-process'
    );
    return (cached = null);
  }
  return (cached = createSqsQueue(url));
}

export function resetInvestigationQueue(): void {
  cached = undefined;
}

export function parseInvestigationMessage(body: string | undefined): InvestigationMessage | null {
  try {
    const parsed = JSON.parse(body ?? '') as Partial<InvestigationMessage>;
    return typeof parsed.alertId === 'string' && parsed.alertId.length > 0
      ? { alertId: parsed.alertId, enqueuedAt: String(parsed.enqueuedAt ?? '') }
      : null;
  } catch {
    return null;
  }
}
