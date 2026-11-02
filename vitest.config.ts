import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run Vitest tests in packages and ingestion-service
    // tests/ belongs to pytest and Playwright
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**'],
  },
});
