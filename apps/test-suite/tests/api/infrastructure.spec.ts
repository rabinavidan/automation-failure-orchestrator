import { test, expect } from '@playwright/test';

test.describe('Infrastructure Failure Simulation', () => {
  test('simulates DNS resolution failure (ENOTFOUND)', async ({ request }) => {
    test.info().annotations.push({ type: 'service', description: 'api-gateway' });
    test.info().annotations.push({ type: 'endpoint', description: '/api/internal' });
    test.info().annotations.push({ type: 'severity', description: 'critical' });

    // Attempt to connect to a non-existent host to simulate ENOTFOUND
    let errorMessage = '';
    try {
      await request.get('http://this-host-does-not-exist-orchestrator.invalid/api', {
        timeout: 3000,
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    // We expect either a DNS error or a timeout — either way this simulates infra failure
    // For demo purposes, if the error occurred we pass; if somehow it succeeded (unlikely) we fail
    if (!errorMessage) {
      throw new Error(
        'ENOTFOUND: getaddrinfo failed for this-host-does-not-exist-orchestrator.invalid'
      );
    }

    // The test "passes" from Playwright's perspective but the error message is captured
    console.log(`Simulated infra error: ${errorMessage}`);
    expect(errorMessage).toBeTruthy();
  });

  test('simulates connection refused (ECONNREFUSED)', async ({ request }) => {
    test.info().annotations.push({ type: 'service', description: 'database' });
    test.info().annotations.push({ type: 'severity', description: 'critical' });

    let errorMessage = '';
    try {
      // Port 19999 should not be listening
      await request.get('http://localhost:19999/health', { timeout: 2000 });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    if (!errorMessage) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:19999');
    }

    console.log(`Simulated connection refused: ${errorMessage}`);
    expect(errorMessage).toBeTruthy();
  });
});
