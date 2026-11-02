import { defineConfig, devices } from '@playwright/test';

/**
 * UI layer: the operations dashboard in a real browser, against the running stack.
 *
 * Data is seeded through the APIs (support/api.ts), never through the UI, and every test seeds
 * its own unique data, so tests run in parallel and in any order. The SignalOps reporter feeds
 * these results back into the platform when SIGNALOPS_INGEST_URL is set (CI dogfooding).
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  workers: CI ? 2 : undefined,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/html', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    [
      '../../packages/playwright-reporter/src/index.ts',
      { outputFile: 'test-results/signalops-results.json' },
    ],
  ],
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // A locally installed Chromium can be pinned when it differs from Playwright's revision.
    launchOptions: process.env.PW_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: 'test-results/artifacts',
});
