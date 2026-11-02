import { expect, test } from '../support/fixtures';

test.describe('integrations', () => {
  test('the Jira view shows the issue a new regression opened', async ({
    api,
    dashboard,
    page,
  }) => {
    const failure = await api.failure();

    await dashboard.open();
    await dashboard.goTo('Jira activity');

    await expect(
      page.locator(`[data-testid="jira-issue"][data-issue-key="${failure.jiraKey}"]`)
    ).toContainText(failure.title);
  });

  test('the Slack view shows the notification for a new failure', async ({
    api,
    dashboard,
    page,
  }) => {
    const failure = await api.failure();

    await dashboard.open();
    await dashboard.goTo('Slack signal');

    await expect(
      page.getByTestId('slack-message').filter({ hasText: failure.title }).first()
    ).toBeVisible();
  });
});

test.describe('resilience', () => {
  test('an API outage shows a degraded banner and keeps existing data', async ({
    api,
    dashboard,
    commandCenter,
    page,
  }) => {
    const failure = await api.failure();
    await dashboard.open();
    await expect(commandCenter.row(failure.fingerprint)).toBeVisible();

    await page.route('**/api/ingestion/api/**', (route) => route.abort('connectionrefused'));
    await dashboard.refreshButton.click();

    await expect(dashboard.degradedBanner).toBeVisible();
    await expect(page.getByText('Degraded')).toBeVisible();
    await expect(commandCenter.row(failure.fingerprint)).toBeVisible();
  });
});
