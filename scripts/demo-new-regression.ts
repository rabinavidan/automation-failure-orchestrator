/**
 * Demo: New Regression
 * A fresh test failure with no prior history — should create a Jira issue.
 */
import { sendRun, basePayload } from './demo-helpers';

async function main() {
  console.log('=== Demo: New Regression ===');
  console.log('Expected: Creates a new Jira issue + Slack notification\n');

  const payload = {
    ...basePayload(),
    summary: { total: 3, passed: 2, failed: 1, skipped: 0 },
    tests: [
      {
        testId: 'tests/api/checkout.spec.ts::checkout-payment-processing',
        title: 'checkout payment processing returns correct total',
        suite: 'Checkout API',
        file: 'tests/api/checkout.spec.ts',
        owner: 'payments-team',
        status: 'failed',
        durationMs: 1234,
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
          severity: 'critical',
          tags: ['payments', 'regression'],
        },
      },
      {
        testId: 'tests/api/checkout.spec.ts::checkout-item-lookup',
        title: 'checkout item lookup returns product details',
        suite: 'Checkout API',
        file: 'tests/api/checkout.spec.ts',
        status: 'passed',
        durationMs: 456,
        retry: 0,
      },
      {
        testId: 'tests/api/checkout.spec.ts::checkout-empty-cart',
        title: 'checkout with empty cart returns 400',
        suite: 'Checkout API',
        file: 'tests/api/checkout.spec.ts',
        status: 'passed',
        durationMs: 200,
        retry: 0,
      },
    ],
  };

  await sendRun(payload);
}

main();
