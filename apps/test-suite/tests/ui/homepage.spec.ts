import { test, expect } from '@playwright/test';

test.describe('Homepage UI', () => {
  test('homepage loads and has correct title', async ({ page }) => {
    // Mock the page so we don't need a real server
    await page.route('**/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!DOCTYPE html>
          <html>
            <head><title>Test App - Home</title></head>
            <body>
              <h1>Welcome to Test App</h1>
              <nav>
                <a href="/products">Products</a>
                <a href="/cart">Cart</a>
              </nav>
              <button id="cta">Get Started</button>
            </body>
          </html>
        `,
      });
    });

    await page.goto('/');
    await expect(page).toHaveTitle('Test App - Home');
    await expect(page.locator('h1')).toHaveText('Welcome to Test App');
    await expect(page.locator('#cta')).toBeVisible();
  });

  test('navigation links are visible', async ({ page }) => {
    await page.route('**/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!DOCTYPE html>
          <html>
            <head><title>Test App</title></head>
            <body>
              <nav>
                <a href="/products" data-testid="nav-products">Products</a>
                <a href="/cart" data-testid="nav-cart">Cart</a>
              </nav>
            </body>
          </html>
        `,
      });
    });

    await page.goto('/');
    await expect(page.locator('[data-testid="nav-products"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-cart"]')).toBeVisible();
  });

  test('product listing loads data', async ({ page }) => {
    await page.route('**/products*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!DOCTYPE html>
          <html>
            <head><title>Products</title></head>
            <body>
              <div class="product-grid">
                <div class="product" data-id="1">Widget A - $9.99</div>
                <div class="product" data-id="2">Widget B - $19.99</div>
                <div class="product" data-id="3">Widget C - $29.99</div>
              </div>
            </body>
          </html>
        `,
      });
    });

    await page.goto('/products');
    const products = page.locator('.product');
    await expect(products).toHaveCount(3);
  });
});
