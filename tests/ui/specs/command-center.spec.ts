import { expect, test } from '../support/fixtures';

test.describe('command center', () => {
  test('a new regression appears with its class, and the dossier shows its identity', async ({
    api,
    dashboard,
    commandCenter,
  }) => {
    const failure = await api.failure();

    await dashboard.open();
    const row = commandCenter.row(failure.fingerprint);
    await expect(row).toBeVisible();
    await expect(row).toContainText(/new regression/i);
    await expect(row).toContainText(failure.title);

    await commandCenter.openDossier(failure.fingerprint);
    await expect(commandCenter.dossier).toContainText(failure.title);
    await expect(commandCenter.dossier).toContainText(failure.fingerprint.slice(0, 16));
    await expect(commandCenter.dossier).toContainText(failure.jiraKey ?? 'Not linked');

    await commandCenter.closeDossier();
  });

  test('infrastructure failures are labelled as such, never as regressions', async ({
    api,
    dashboard,
    commandCenter,
  }) => {
    const failure = await api.failure({ message: 'connect ECONNREFUSED 10.0.0.12:5432' });

    await dashboard.open();

    await expect(commandCenter.row(failure.fingerprint)).toContainText(/infrastructure/i);
    await commandCenter.openDossier(failure.fingerprint);
    await expect(commandCenter.dossier).toContainText('Not linked');
  });

  test('the filter narrows the list to matching signals', async ({
    api,
    dashboard,
    commandCenter,
  }) => {
    const wanted = await api.failure({ title: `Refund flow ${crypto.randomUUID().slice(0, 8)}` });
    const other = await api.failure();

    await dashboard.open();
    await commandCenter.filter.fill(wanted.title);

    await expect(commandCenter.row(wanted.fingerprint)).toBeVisible();
    await expect(commandCenter.row(other.fingerprint)).toHaveCount(0);
  });
});
