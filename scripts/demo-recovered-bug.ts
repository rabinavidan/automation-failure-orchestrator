/**
 * Demo: Recovered Bug
 * A test that previously had a Jira issue now passes consistently.
 * Run after demo-new-regression.ts to have an existing Jira issue.
 * Expected: possibly_fixed classification after consecutive passes.
 */
import { sendRun, basePayload } from './demo-helpers';

const RECOVERED_TEST = {
  testId: 'tests/api/checkout.spec.ts::checkout-payment-processing',
  title: 'checkout payment processing returns correct total',
  suite: 'Checkout API',
  file: 'tests/api/checkout.spec.ts',
  owner: 'payments-team',
  status: 'passed' as const,
  durationMs: 445,
  retry: 0,
  metadata: {
    service: 'checkout-service',
    endpoint: '/api/checkout/process',
    severity: 'critical' as const,
    tags: ['payments'],
  },
};

async function main() {
  console.log('=== Demo: Recovered Bug ===');
  console.log('Sending 3 consecutive passes to trigger recovery detection...\n');

  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- Pass ${i} of 3 ---`);
    await sendRun({
      ...basePayload({ branch: 'fix/payment-gateway' }),
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      tests: [RECOVERED_TEST],
    });
  }

  console.log('\nExpected: After 3 consecutive passes, classified as possibly_fixed');
}

main();
