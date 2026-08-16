/**
 * Demo: Flaky Test
 * Test with retry=1 — failed initially, eventually passed on retry.
 * Expected: classified as flaky, Slack notification only.
 */
import { sendRun, basePayload } from './demo-helpers';

async function main() {
  console.log('=== Demo: Flaky Test ===');
  console.log('Expected: Classified as flaky (retry > 0), Slack only\n');

  const payload = {
    ...basePayload(),
    summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    tests: [
      {
        testId: 'tests/ui/cart.spec.ts::cart-count-update',
        title: 'cart count updates after adding item',
        suite: 'Cart UI',
        file: 'tests/ui/cart.spec.ts',
        status: 'failed',
        durationMs: 3200,
        retry: 1, // This indicates it was retried — key flaky signal
        error: {
          name: 'TimeoutError',
          message: 'Timeout 30000ms exceeded waiting for locator #cart-count to have text "3"',
          stack:
            'TimeoutError: Timeout 30000ms exceeded\n    at cart.spec.ts:28:7\n    at Locator.waitFor (locator.js:234:5)',
        },
        metadata: {
          service: 'cart-service',
          endpoint: '/api/cart/count',
          severity: 'medium',
          tags: ['ui', 'cart', 'flaky'],
        },
      },
      {
        testId: 'tests/ui/cart.spec.ts::cart-total-calculation',
        title: 'cart total calculates correctly',
        suite: 'Cart UI',
        file: 'tests/ui/cart.spec.ts',
        status: 'passed',
        durationMs: 890,
        retry: 0,
      },
    ],
  };

  await sendRun(payload);
}

main();
