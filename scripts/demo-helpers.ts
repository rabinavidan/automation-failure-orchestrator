import { randomUUID } from 'crypto';

const BASE_URL = process.env.INGESTION_URL ?? 'http://localhost:3001';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';

export function makeRunId(): string {
  return randomUUID();
}

export function makeTimestamps(offsetMs: number = 5000): { startedAt: string; finishedAt: string } {
  const start = new Date(Date.now() - offsetMs);
  const end = new Date();
  return { startedAt: start.toISOString(), finishedAt: end.toISOString() };
}

export async function sendRun(payload: unknown): Promise<void> {
  console.log('\n--- Sending test run payload ---');
  console.log(JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    console.log('\n--- Response ---');
    console.log(`Status: ${response.status}`);
    console.log(JSON.stringify(body, null, 2));
  } catch (err) {
    console.error('Failed to send run:', err);
    process.exit(1);
  }
}

export function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { startedAt, finishedAt } = makeTimestamps();
  return {
    schemaVersion: '1.0.0',
    runId: makeRunId(),
    repository: 'acme/test-suite',
    branch: 'main',
    commitSha: 'abc123def456789012345678901234567890abcd',
    environment: 'staging',
    triggeredBy: 'demo-script',
    startedAt,
    finishedAt,
    ...overrides,
  };
}
