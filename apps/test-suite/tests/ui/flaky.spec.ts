import { test, expect } from '@playwright/test';

/**
 * Flaky test simulation.
 * When FLAKY_PASS is set to 'true', test passes; otherwise fails.
 * In CI, set FLAKY_PASS=true on retry to simulate flakiness.
 */
test.describe('Flaky Test Simulation', () => {
  test('intermittent cart count update', async ({ page }) => {
    test.info().annotations.push({ type: 'severity', description: 'medium' });

    // Simulate flakiness: fail on first attempt, pass on retry
    const shouldPass = process.env.FLAKY_PASS === 'true' || test.info().retry > 0;

    await page.route('**/cart*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!DOCTYPE html>
          <html>
            <head><title>Cart</title></head>
            <body>
              <div id="cart-count">${shouldPass ? '3' : '0'}</div>
              <div class="cart-item">Item 1</div>
              <div class="cart-item">Item 2</div>
              <div class="cart-item">Item 3</div>
            </body>
          </html>
        `,
      });
    });

    await page.goto('/cart');

    const cartCount = page.locator('#cart-count');
    await expect(cartCount).toHaveText('3');
  });

  test('random timing-dependent animation', async ({ page }) => {
    test.info().annotations.push({ type: 'severity', description: 'low' });

    // This test simulates a race condition that's timing-dependent
    const delay = process.env.SLOW_NETWORK === 'true' ? 5000 : 100;

    await page.route('**/*', (route) => {
      setTimeout(() => {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `
            <!DOCTYPE html>
            <html>
              <head><title>Animation Test</title></head>
              <body>
                <div id="animated" style="opacity: 1">Content loaded</div>
              </body>
            </html>
          `,
        });
      }, delay);
    });

    await page.goto('/', { timeout: 10000 });
    await expect(page.locator('#animated')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#animated')).toHaveText('Content loaded');
  });
});
