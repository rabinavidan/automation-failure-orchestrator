/**
 * Demo: Duplicate Delivery
 * Same runId sent twice — second request should be idempotent (no reprocessing).
 */
import { sendRun, basePayload, makeRunId } from './demo-helpers';

async function main() {
  console.log('=== Demo: Duplicate Delivery ===');
  console.log('Expected: First request processes normally; second returns duplicate flag\n');

  const sharedRunId = makeRunId();

  const payload = {
    ...basePayload({ runId: sharedRunId }),
    summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    tests: [
      {
        testId: 'tests/api/users.spec.ts::user-registration',
        title: 'user registration with valid data succeeds',
        suite: 'Users API',
        file: 'tests/api/users.spec.ts',
        status: 'failed',
        durationMs: 678,
        retry: 0,
        error: {
          name: 'AssertionError',
          message: 'Expected response body to contain { id: Number }, got null',
          stack: 'AssertionError: Expected...\n    at users.spec.ts:56:10',
        },
        metadata: {
          service: 'user-service',
          endpoint: '/api/users/register',
          severity: 'high',
        },
      },
      {
        testId: 'tests/api/users.spec.ts::user-login',
        title: 'user login with valid credentials returns token',
        suite: 'Users API',
        file: 'tests/api/users.spec.ts',
        status: 'passed',
        durationMs: 234,
        retry: 0,
      },
    ],
  };

  console.log(`Run ID: ${sharedRunId}\n`);

  console.log('--- Sending first request (should process) ---');
  await sendRun(payload);

  console.log('\n--- Sending duplicate request (should be idempotent) ---');
  await sendRun(payload);

  console.log('\nExpected: Second response includes { duplicateRun: true }');
}

main();
