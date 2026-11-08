import type { Locator, Page } from '@playwright/test';

/** "AI observability": the committed benchmark, model-call telemetry and per-node performance. */
export class ObservabilityPage {
  readonly benchmark: Locator;
  readonly recentCalls: Locator;
  readonly nodePerformance: Locator;

  constructor(readonly page: Page) {
    this.benchmark = page.getByRole('region', { name: 'Benchmark' });
    this.recentCalls = page.getByRole('region', { name: 'Recent model calls list' });
    this.nodePerformance = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Node performance' }) });
  }

  /** One committed benchmark report, identified by its dataset line (e.g. "@1.1.0 · 35 cases"). */
  report(datasetText: string): Locator {
    return this.benchmark.locator('div').filter({ hasText: datasetText }).last();
  }
}
