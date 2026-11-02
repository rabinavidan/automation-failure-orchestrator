import { expect, test } from '../support/fixtures';

test.describe('SOC console', () => {
  test('a confirmed brute force is queued as P1 true positive with containment pending', async ({
    api,
    dashboard,
    socConsole,
  }) => {
    const alert = await api.bruteForceAlert();

    await dashboard.open();
    await dashboard.goTo('SOC console');

    const row = socConsole.alertRow(alert.alertId);
    await expect(row).toContainText('P1');
    await expect(row).toContainText(/true positive/i);
    await expect(socConsole.pendingAction(alert.containmentActionId)).toContainText(alert.sourceIp);
  });

  test('the alert detail explains the triage decision', async ({ api, dashboard, socConsole }) => {
    const alert = await api.bruteForceAlert();

    await dashboard.open();
    await dashboard.goTo('SOC console');
    await socConsole.openAlert(alert.alertId);

    await expect(socConsole.alertDetail).toContainText('Brute Force');
    await expect(socConsole.alertDetail).toContainText(alert.sourceIp);
    await socConsole.alertDetail.getByRole('button', { name: 'Close' }).click();
    await expect(socConsole.alertDetail).toBeHidden();
  });

  test('a responder approves the block, then rolls it back', async ({
    api,
    dashboard,
    socConsole,
    signedInAs,
  }) => {
    const alert = await api.bruteForceAlert();
    await signedInAs('soc_responder');
    await dashboard.open();
    await dashboard.goTo('SOC console');

    await socConsole
      .pendingAction(alert.containmentActionId)
      .getByRole('button', { name: 'Approve & execute' })
      .click();

    const active = socConsole.activeContainment(alert.containmentActionId);
    await expect(active).toContainText('demo-soc-responder');
    expect(Object.keys(await api.firewallBlocks())).toContain(alert.sourceIp);

    await active.getByRole('button', { name: 'Roll back' }).click();

    await expect(active).toHaveCount(0);
    expect(Object.keys(await api.firewallBlocks())).not.toContain(alert.sourceIp);
  });

  test('without the responder role, containment cannot be approved', async ({
    api,
    dashboard,
    socConsole,
    signedInAs,
  }) => {
    const alert = await api.bruteForceAlert();
    await signedInAs('ci_reviewer');

    await dashboard.open();
    await dashboard.goTo('SOC console');

    await expect(
      socConsole
        .pendingAction(alert.containmentActionId)
        .getByRole('button', { name: 'Approve & execute' })
    ).toBeDisabled();
  });

  test('the disposition filter narrows the queue', async ({ api, dashboard, socConsole }) => {
    const alert = await api.bruteForceAlert();
    await dashboard.open();
    await dashboard.goTo('SOC console');

    await socConsole.dispositionFilter.selectOption('false_positive');
    await expect(socConsole.alertRow(alert.alertId)).toHaveCount(0);

    await socConsole.dispositionFilter.selectOption('true_positive');
    await expect(socConsole.alertRow(alert.alertId)).toBeVisible();
  });
});
