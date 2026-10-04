/**
 * Zero-cost AWS demo: the AWS code path end to end, on your machine.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.aws-local.yml up --build -d
 *   npm run demo:aws-local
 *
 * A Splunk alert is ingested; the API enqueues its advisory investigation on SQS
 * (emulated by moto, open source, no AWS account); the investigation worker, the same
 * container the Terraform deploys to ECS, consumes it and persists the result. No cloud
 * resources are created and nothing is billed. Exits non-zero if any step fails (CI).
 */
import { randomUUID } from 'crypto';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

const BASE_URL = process.env.INGESTION_URL ?? 'http://localhost:3001';
const SECRET = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';
const SQS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const QUEUE_BASE = `${SQS_ENDPOINT}/123456789012`;

const sqs = new SQSClient({
  endpoint: SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function depth(queue: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: `${QUEUE_BASE}/${queue}`,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })
  );
  return `${Attributes?.ApproximateNumberOfMessages ?? '?'} visible / ${Attributes?.ApproximateNumberOfMessagesNotVisible ?? '?'} in flight`;
}

async function main() {
  console.log('=== Zero-cost AWS demo: SQS-backed investigation worker (moto) ===\n');
  const attacker = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;

  const response = await fetch(`${BASE_URL}/api/alerts/splunk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify({
      sid: `aws-local-${randomUUID()}`,
      search_name: 'Access - Brute Force Access Behavior Detected - Rule',
      result: {
        _time: String(Math.floor(Date.now() / 1000)),
        signature: 'Brute Force Access Behavior Detected',
        src: attacker,
        dest: `ws-${randomUUID().slice(0, 4)}`,
        user: 'jdoe',
        urgency: 'high',
      },
    }),
  });
  const alert = (await response.json()) as {
    alertId: string;
    triage?: { disposition: string; priority: string };
    investigation?: { status: string; queue?: string };
  };
  console.log(`1. Ingested ${alert.alertId}`);
  console.log(`   triage: ${alert.triage?.disposition} ${alert.triage?.priority}`);
  console.log(`   investigation: ${JSON.stringify(alert.investigation)}`);
  if (alert.investigation?.queue !== 'sqs') {
    fail('investigation was not handed to SQS (is the aws-local override running?)');
  }

  console.log(`2. Queue right after ingest: ${await depth('soc-investigations')}`);

  const deadline = Date.now() + 90_000;
  let status = 'queued';
  let detail: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/alerts/${encodeURIComponent(alert.alertId)}`);
    detail = ((await res.json()) as { alert: Record<string, unknown> }).alert;
    status = String(detail.ai_investigation_status ?? 'queued');
    if (status === 'completed' || status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  console.log(`3. Worker result: ai_investigation_status = ${status}`);
  if (status !== 'completed') fail(`worker did not complete the investigation (status ${status})`);

  const investigation = detail.ai_investigation as {
    recommendedResponse: string;
    requiresHumanApproval: boolean;
    citedRunbooks: string[];
    graphVersion: string;
  };
  const evaluation = detail.ai_evaluation as { passed: boolean; failures: string[] };
  console.log(
    `   ${investigation.graphVersion}: recommends ${investigation.recommendedResponse}, ` +
      `human approval ${investigation.requiresHumanApproval ? 'required' : 'not required'}, ` +
      `runbooks ${investigation.citedRunbooks.join(', ') || '-'}`
  );
  console.log(
    `   evaluation gate: ${evaluation.passed ? 'passed' : evaluation.failures.join('; ')}`
  );

  const [queue, dlq] = await Promise.all([
    depth('soc-investigations'),
    depth('soc-investigations-dlq'),
  ]);
  console.log(`4. Queue after processing: ${queue}; dead-letter queue: ${dlq}`);
  if (!queue.startsWith('0 visible / 0')) fail('message was not deleted after processing');

  console.log('\n✓ AWS code path verified locally at zero cost (no AWS account used).');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
