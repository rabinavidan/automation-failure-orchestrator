import { expect, test } from '@playwright/test';

// RUN_TOKEN makes test IDs (and therefore fingerprints) unique per pytest run.
const token = process.env.RUN_TOKEN ?? 'local';

test.describe(`checkout ${token}`, () => {
  test('passes', () => {
    expect(1 + 1).toBe(2);
  });

  // Playwright requires the fixtures argument to be a destructuring pattern, even when empty.
  // eslint-disable-next-line no-empty-pattern
  test('flaky: fails first, passes on retry', ({}, testInfo) => {
    test.info().annotations.push({ type: 'service', description: 'cart-service' });
    expect(testInfo.retry, 'cart badge count').toBe(1);
  });

  test('always fails with HTTP 500', () => {
    test.info().annotations.push({ type: 'service', description: 'orders-service' });
    test.info().annotations.push({ type: 'endpoint', description: '/api/orders' });
    test.info().annotations.push({ type: 'severity', description: 'critical' });
    expect(500, 'POST /api/orders status').toBe(201);
  });

  test('times out', async () => {
    test.setTimeout(300);
    await new Promise((done) => setTimeout(done, 1_000));
  });

  test.skip('is skipped', () => {});
});

test.describe(`cart ${token}`, () => {
  // Same title as in the describe above: test IDs must still be unique.
  test('passes', () => {
    expect([1, 2, 3]).toHaveLength(3);
  });
});
