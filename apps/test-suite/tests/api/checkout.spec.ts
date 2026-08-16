import { test, expect } from '@playwright/test';

test.describe('Checkout API', () => {
  test('GET /posts returns 200 with posts @smoke', async ({ request }) => {
    test.info().annotations.push({ type: 'service', description: 'checkout-service' });
    test.info().annotations.push({ type: 'endpoint', description: '/api/checkout' });
    test.info().annotations.push({ type: 'severity', description: 'high' });

    const response = await request.get('https://jsonplaceholder.typicode.com/posts/1');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('id', 1);
    expect(body).toHaveProperty('title');
  });

  test('checkout with valid item returns product details', async ({ request }) => {
    test.info().annotations.push({ type: 'service', description: 'checkout-service' });
    test.info().annotations.push({ type: 'endpoint', description: '/api/checkout' });

    const response = await request.get('https://jsonplaceholder.typicode.com/posts/2');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(2);
  });

  test('checkout product failure simulates 500 error', async ({ request }) => {
    test.info().annotations.push({ type: 'service', description: 'checkout-service' });
    test.info().annotations.push({ type: 'endpoint', description: '/api/checkout' });
    test.info().annotations.push({ type: 'severity', description: 'critical' });

    // This test simulates a product failure by expecting a non-existent endpoint behavior
    // In a real environment this would hit a 500 endpoint
    const response = await request.get('https://jsonplaceholder.typicode.com/posts/99999');

    // jsonplaceholder returns 404 for non-existent posts
    // We expect 200 here to simulate a failing test
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('id', 99999);
  });
});
