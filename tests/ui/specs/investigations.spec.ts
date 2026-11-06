import { expect, test } from '../support/fixtures';

test.describe('AI investigations', () => {
  test('the dossier shows the root cause, evidence and every specialist report', async ({
    api,
    dashboard,
    investigations,
  }) => {
    const failure = await api.failureWithInvestigation();

    await dashboard.open();
    await dashboard.goTo('AI investigations');
    const dossier = investigations.dossier(failure.title);

    await expect(dossier).toBeVisible();
    await expect(dossier.getByText(failure.rootCause)).toBeVisible();
    await expect(dossier.getByText(failure.evidence)).toBeVisible();
    for (const agent of ['triage', 'repository', 'action'] as const) {
      await expect(investigations.specialist(dossier, agent)).toBeVisible();
    }
    await expect(dossier.getByText('82%', { exact: true })).toBeVisible();
    await expect(dossier.getByText('create_issue', { exact: true })).toBeVisible();
  });

  test('the dossier names the stub as its model, never a real one', async ({
    api,
    dashboard,
    investigations,
  }) => {
    const failure = await api.failureWithInvestigation();

    await dashboard.open();
    await dashboard.goTo('AI investigations');

    await expect(investigations.dossier(failure.title).getByText('demo-stub')).toBeVisible();
  });
});
