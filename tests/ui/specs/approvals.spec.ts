import { expect, test, TOKENS } from '../support/fixtures';

test.describe('approval queue', () => {
  test('signed out, a reviewer can see the request but cannot decide', async ({
    api,
    dashboard,
    approvals,
  }) => {
    const failure = await api.failureAwaitingApproval();

    await dashboard.open();
    await dashboard.goTo('Approval queue');

    await expect(approvals.card(failure.threadId!)).toContainText('awaiting human');
    await expect(approvals.approveButton(failure.threadId!)).toBeDisabled();
    await expect(approvals.rejectButton(failure.threadId!)).toBeDisabled();
  });

  test('an unknown token is rejected by the server', async ({ dashboard, approvals }) => {
    await dashboard.open();
    await dashboard.goTo('Approval queue');

    await approvals.signIn('not-a-real-token-000000000000');

    await expect(approvals.signInError).toHaveText('Token not recognized');
  });

  test('a CI reviewer signs in, approves, and the paused actions run', async ({
    api,
    dashboard,
    approvals,
    page,
  }) => {
    const failure = await api.failureAwaitingApproval();
    expect(await api.jiraIssuesFor(failure.fingerprint)).toEqual([]);

    await dashboard.open();
    await dashboard.goTo('Approval queue');
    await approvals.signIn(TOKENS.ci_reviewer);
    await expect(page.getByText('Signed in as')).toContainText('demo-ci-reviewer');

    await approvals.approveButton(failure.threadId!).click();

    await expect(approvals.card(failure.threadId!)).toHaveCount(0);
    await expect
      .poll(async () => (await api.jiraIssuesFor(failure.fingerprint)).length, {
        message: 'exactly one Jira issue opened for this failure',
      })
      .toBe(1);
  });

  test('a SOC responder cannot decide CI approvals', async ({
    api,
    dashboard,
    approvals,
    signedInAs,
  }) => {
    const failure = await api.failureAwaitingApproval();
    await signedInAs('soc_responder');

    await dashboard.open();
    await dashboard.goTo('Approval queue');

    await expect(approvals.signOutButton).toBeVisible();
    await expect(approvals.approveButton(failure.threadId!)).toBeDisabled();
  });

  test('a rejection removes the request without opening an issue', async ({
    api,
    dashboard,
    approvals,
    signedInAs,
  }) => {
    const failure = await api.failureAwaitingApproval();
    await signedInAs('ci_reviewer');

    await dashboard.open();
    await dashboard.goTo('Approval queue');
    await approvals.rejectButton(failure.threadId!).click();

    await expect(approvals.card(failure.threadId!)).toHaveCount(0);
    expect(await api.jiraIssuesFor(failure.fingerprint)).toEqual([]);
  });
});
