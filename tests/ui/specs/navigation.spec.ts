import { expect, test } from '../support/fixtures';
import type { ViewName } from '../pages/DashboardPage';

const VIEWS: ViewName[] = [
  'Command center',
  'SOC console',
  'AI observability',
  'Approval queue',
  'Knowledge RAG',
  'AI investigations',
  'Jira activity',
  'Slack signal',
];

test.describe('navigation', () => {
  test('every view is reachable and marked as current', async ({ dashboard }) => {
    await dashboard.open();
    await expect(dashboard.heading).toHaveText('Command center');

    for (const view of VIEWS) {
      await dashboard.goTo(view);
    }
  });

  test('a view is addressable by URL and follows browser history', async ({ dashboard, page }) => {
    await page.goto('/#/approvals');
    await expect(dashboard.heading).toHaveText('Approval queue');
    await expect(dashboard.navItem('Approval queue')).toHaveAttribute('aria-current', 'page');

    await dashboard.goTo('Jira activity');
    await expect(page).toHaveURL(/#\/jira$/);
    await page.goBack();
    await expect(dashboard.heading).toHaveText('Approval queue');

    await page.reload();
    await expect(dashboard.heading).toHaveText('Approval queue');
  });

  test('an unknown route falls back to the command center', async ({ dashboard, page }) => {
    await page.goto('/#/no-such-view');
    await expect(dashboard.heading).toHaveText('Command center');
  });

  test('each view fetches only its own endpoints', async ({ dashboard, page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) requested.push(path);
    });

    await dashboard.open();
    // The command center needs runs and failures; pending approvals feed the one live badge.
    await expect.poll(() => requested).toContain('/api/ingestion/api/failures');
    for (const elsewhere of [
      '/api/mock/jira/issues',
      '/api/mock/slack/messages',
      '/api/ingestion/api/observability/summary',
      '/api/ingestion/api/knowledge/status',
    ]) {
      expect(requested, `${elsewhere} is fetched by another view`).not.toContain(elsewhere);
    }

    await dashboard.goTo('Jira activity');
    await expect.poll(() => requested).toContain('/api/mock/jira/issues');
    expect(requested).not.toContain('/api/mock/slack/messages');
  });

  test('runtime capabilities state the model backend honestly', async ({ dashboard, page }) => {
    await dashboard.open();
    // The stack runs the deterministic demo stub: the UI must not present it as a model.
    await expect(page.getByText(/stub|disabled|real model/i).first()).toBeVisible();
  });
});
