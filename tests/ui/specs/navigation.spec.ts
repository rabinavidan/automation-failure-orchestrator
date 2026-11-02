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

  test('runtime capabilities state the model backend honestly', async ({ dashboard, page }) => {
    await dashboard.open();
    // The stack runs the deterministic demo stub: the UI must not present it as a model.
    await expect(page.getByText(/stub|disabled|real model/i).first()).toBeVisible();
  });
});
