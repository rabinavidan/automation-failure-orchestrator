/**
 * Creates the SQS investigation queue + dead-letter queue (same settings as
 * infra/terraform/sqs.tf) on a local AWS emulator. Idempotent.
 *   AWS_ENDPOINT_URL=http://localhost:4566 node scripts/aws-local-init.mjs
 */
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const dlq = await sqs.send(
  new CreateQueueCommand({
    QueueName: 'soc-investigations-dlq',
    Attributes: { MessageRetentionPeriod: '1209600' },
  })
);
const { Attributes } = await sqs.send(
  new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] })
);
const queue = await sqs.send(
  new CreateQueueCommand({
    QueueName: 'soc-investigations',
    Attributes: {
      VisibilityTimeout: '360',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes?.QueueArn,
        maxReceiveCount: '3',
      }),
    },
  })
);
console.log(`[aws-local-init] ready: ${queue.QueueUrl} (DLQ ${dlq.QueueUrl})`);
