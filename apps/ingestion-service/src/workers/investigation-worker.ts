import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { closePool } from '../db/client';
import { loadInvestigationInput, runAlertInvestigation } from '../services/alert-investigation';
import { parseInvestigationMessage } from '../services/investigation-queue';

/**
 * SQS consumer for advisory SOC investigations (ECS service `investigation-worker`).
 *
 * Delivery semantics: at-least-once. A message is deleted only after the investigation
 * is persisted (or found already completed, or unprocessable). Failures leave it on the
 * queue; after the redrive policy's maxReceiveCount it moves to the dead-letter queue.
 */
export type WorkerOutcome = 'completed' | 'skipped_completed' | 'discarded' | 'retry';

export interface WorkerDeps {
  load: typeof loadInvestigationInput;
  run: (
    input: NonNullable<Awaited<ReturnType<typeof loadInvestigationInput>>['input']>
  ) => Promise<{
    status: 'completed' | 'failed';
  }>;
}

const defaultDeps: WorkerDeps = {
  load: loadInvestigationInput,
  run: (input) => runAlertInvestigation(input),
};

export async function processMessage(
  body: string | undefined,
  deps: WorkerDeps = defaultDeps
): Promise<WorkerOutcome> {
  const message = parseInvestigationMessage(body);
  if (!message) return 'discarded'; // poison message: never retry malformed input

  const { input, alreadyCompleted } = await deps.load(message.alertId);
  if (!input) return 'discarded'; // alert deleted or never triaged
  if (alreadyCompleted) return 'skipped_completed'; // idempotent redelivery

  const result = await deps.run(input);
  return result.status === 'completed' ? 'completed' : 'retry';
}

/** Backoff that ends early on shutdown, so SIGTERM never waits out a retry delay. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export async function runWorker(options: {
  queueUrl: string;
  client?: SQSClient;
  signal?: AbortSignal;
  deps?: WorkerDeps;
}): Promise<void> {
  const client = options.client ?? new SQSClient({});
  console.log('[Worker] consuming', options.queueUrl);

  while (!options.signal?.aborted) {
    let messages: Message[] = [];
    try {
      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 300,
        }),
        { abortSignal: options.signal }
      );
      messages = received.Messages ?? [];
    } catch (err) {
      if (options.signal?.aborted) break;
      console.error('[Worker] receive failed:', err instanceof Error ? err.name : err);
      await sleep(5_000, options.signal);
      continue;
    }

    for (const message of messages) {
      let outcome: WorkerOutcome;
      try {
        outcome = await processMessage(message.Body, options.deps);
      } catch (err) {
        console.error('[Worker] processing error:', err instanceof Error ? err.name : err);
        outcome = 'retry';
      }
      console.log(`[Worker] ${message.MessageId}: ${outcome}`);

      if (outcome === 'retry') {
        // Back off before the next attempt instead of waiting out the full visibility timeout.
        await client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: options.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 60,
            })
          )
          .catch(() => undefined);
      } else {
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: options.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          })
        );
      }
    }
  }
}

if (require.main === module) {
  const queueUrl = process.env.INVESTIGATION_QUEUE_URL;
  if (!queueUrl) {
    console.error('[Worker] INVESTIGATION_QUEUE_URL is required');
    process.exit(1);
  }
  const controller = new AbortController();
  // ECS sends SIGTERM on deploy/scale-in: finish the current batch, then exit.
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  runWorker({ queueUrl, signal: controller.signal })
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Worker] fatal:', err);
      process.exit(1);
    });
}
