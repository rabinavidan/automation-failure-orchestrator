import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run Vitest tests in packages and ingestion-service
    // Exclude Playwright spec files in test-suite
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/test-suite/**'],
  },
});
