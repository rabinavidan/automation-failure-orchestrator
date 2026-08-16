/**
 * Demo: Known Bug
 * The same fingerprint sent twice — second run should identify it as a known bug.
 * Run demo-new-regression.ts first to create the initial Jira issue.
 */
import { sendRun, basePayload } from './demo-helpers';

const KNOWN_BUG_TEST = {
  testId: 'tests/api/checkout.spec.ts::checkout-payment-processing',
  title: 'checkout payment processing returns correct total',
  suite: 'Checkout API',
  file: 'tests/api/checkout.spec.ts',
  owner: 'payments-team',
  status: 'failed' as const,
  durationMs: 1100,
  retry: 0,
  error: {
    name: 'AssertionError',
    message: 'Expected status 200, received 500. Server error: Payment gateway unavailable',
    stack:
      'AssertionError: Expected status 200, received 500\n    at checkout.spec.ts:45:5\n    at runTest (runner.js:100:10)',
  },
  metadata: {
    service: 'checkout-service',
    endpoint: '/api/checkout/process',
    severity: 'critical' as const,
    tags: ['payments'],
  },
};

async function main() {
  console.log('=== Demo: Known Bug (Run 1 of 2) ===');
  console.log('Sending first occurrence to establish fingerprint...\n');

  await sendRun({
    ...basePayload({ branch: 'feature/new-payment-flow' }),
    summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
    tests: [KNOWN_BUG_TEST],
  });

  console.log('\n\n=== Demo: Known Bug (Run 2 of 2) ===');
  console.log('Expected: Identifies as known bug, adds Jira comment\n');

  await sendRun({
    ...basePayload({ branch: 'main' }),
    summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
    tests: [{ ...KNOWN_BUG_TEST, durationMs: 1300 }],
  });
}

main();
