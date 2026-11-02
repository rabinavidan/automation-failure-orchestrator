// Fixture project for tests/backend/contract/test_playwright_reporter.py. No browser needed:
// every outcome the reporter must handle, produced deterministically with retries enabled.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  retries: 1,
  workers: 1,
  timeout: 5_000,
  reporter: [['../../../../packages/playwright-reporter/src/index.ts']],
  outputDir: process.env.SIGNALOPS_FIXTURE_OUTPUT_DIR ?? 'test-results',
});
