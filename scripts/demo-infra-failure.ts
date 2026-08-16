/**
 * Demo: Infrastructure Failure
 * ECONNREFUSED error — should be classified as infrastructure, Slack only.
 */
import { sendRun, basePayload } from './demo-helpers';

async function main() {
  console.log('=== Demo: Infrastructure Failure ===');
  console.log('Expected: Classified as infrastructure, Slack notification only\n');

  const payload = {
    ...basePayload({ environment: 'staging' }),
    summary: { total: 4, passed: 1, failed: 3, skipped: 0 },
    tests: [
      {
        testId: 'tests/api/orders.spec.ts::order-creation',
        title: 'POST /orders creates a new order',
        suite: 'Orders API',
        file: 'tests/api/orders.spec.ts',
        status: 'failed',
        durationMs: 5000,
        retry: 0,
        error: {
          name: 'Error',
          message: 'connect ECONNREFUSED 10.0.1.45:5432 - PostgreSQL database is unreachable',
          stack:
            'Error: connect ECONNREFUSED 10.0.1.45:5432\n    at TCPConnectWrap.afterConnect (net.js:1141:16)',
        },
        metadata: {
          service: 'orders-service',
          endpoint: '/api/orders',
          severity: 'critical',
          tags: ['orders', 'database'],
        },
      },
      {
        testId: 'tests/api/orders.spec.ts::order-listing',
        title: 'GET /orders returns paginated list',
        suite: 'Orders API',
        file: 'tests/api/orders.spec.ts',
        status: 'failed',
        durationMs: 5000,
        retry: 0,
        error: {
          name: 'Error',
          message: 'connect ECONNREFUSED 10.0.1.45:5432',
          stack: 'Error: connect ECONNREFUSED\n    at orders.spec.ts:67:5',
        },
        metadata: {
          service: 'orders-service',
          endpoint: '/api/orders',
          severity: 'high',
        },
      },
      {
        testId: 'tests/api/orders.spec.ts::order-cancellation',
        title: 'DELETE /orders/:id cancels an order',
        suite: 'Orders API',
        file: 'tests/api/orders.spec.ts',
        status: 'failed',
        durationMs: 5000,
        retry: 0,
        error: {
          name: 'Error',
          message: 'ETIMEDOUT: Connection timed out to database server',
          stack: 'Error: ETIMEDOUT\n    at orders.spec.ts:89:5',
        },
        metadata: {
          service: 'orders-service',
          severity: 'high',
        },
      },
      {
        testId: 'tests/api/products.spec.ts::product-search',
        title: 'GET /products returns search results',
        suite: 'Products API',
        file: 'tests/api/products.spec.ts',
        status: 'passed',
        durationMs: 234,
        retry: 0,
      },
    ],
  };

  await sendRun(payload);
}

main();
