import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';
import type { ViewName } from '../pages/DashboardPage';

/**
 * WCAG 2.1 A/AA checks with axe-core on every view. Motion is reduced so the page-enter fade is
 * finished when axe measures colours; the dashboard honours prefers-reduced-motion for users too.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
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

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const summarize = (violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) =>
  violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
  );

test.describe('accessibility', () => {
  for (const view of VIEWS) {
    test(`${view} has no WCAG 2.1 AA violations`, async ({ api, dashboard, page }) => {
      // Seed data so the view renders its populated state, not only the empty one.
      await api.failureWithInvestigation();
      await api.bruteForceAlert();
      await dashboard.open();
      await dashboard.goTo(view);

      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();

      expect(summarize(results.violations)).toEqual([]);
    });
  }

  test('the SOC alert detail dialog has no WCAG 2.1 AA violations', async ({
    api,
    dashboard,
    socConsole,
    page,
  }) => {
    const alert = await api.bruteForceAlert();
    await dashboard.open();
    await dashboard.goTo('SOC console');
    await socConsole.openAlert(alert.alertId);

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"][aria-label="Alert detail"]')
      .withTags(WCAG)
      .analyze();

    expect(summarize(results.violations)).toEqual([]);
  });
});
