import { expect, type Locator, type Page } from '@playwright/test';

export type ViewName =
  | 'Command center'
  | 'SOC console'
  | 'AI observability'
  | 'Approval queue'
  | 'Knowledge RAG'
  | 'AI investigations'
  | 'Jira activity'
  | 'Slack signal';

/** The application shell: navigation, page heading, refresh and the degraded banner. */
export class DashboardPage {
  readonly heading: Locator;
  readonly refreshButton: Locator;
  readonly degradedBanner: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.refreshButton = page.getByRole('button', { name: 'Refresh' }).first();
    this.degradedBanner = page.getByText('Existing data remains visible.');
  }

  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.page.getByLabel('Loading dashboard')).toHaveCount(0);
  }

  navItem(view: ViewName): Locator {
    return this.page.getByRole('navigation').getByRole('button', { name: view });
  }

  async goTo(view: ViewName): Promise<void> {
    await this.navItem(view).click();
    await expect(this.heading).toHaveText(view);
    await expect(this.navItem(view)).toHaveAttribute('aria-current', 'page');
  }

  /** The value shown on a metric card, by its label (e.g. "Agent executions"). */
  metric(label: string): Locator {
    return this.page
      .getByRole('article')
      .filter({ has: this.page.getByText(label, { exact: true }) })
      .locator('p')
      .nth(1);
  }

  async refresh(): Promise<void> {
    await this.refreshButton.click();
    await expect(this.refreshButton).toBeEnabled();
  }
}
