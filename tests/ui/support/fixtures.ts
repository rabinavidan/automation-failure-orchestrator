/**
 * Test fixtures: page objects, an API seeder, and reviewer identities.
 *
 * Reviewer sign-in stores the token in sessionStorage, which Playwright's storageState does
 * not persist, so `signedInAs` seeds it with an init script. The sign-in form itself is
 * exercised by approvals.spec.ts.
 */
import { test as base } from '@playwright/test';
import { ApprovalQueuePage } from '../pages/ApprovalQueuePage';
import { CommandCenterPage } from '../pages/CommandCenterPage';
import { DashboardPage } from '../pages/DashboardPage';
import { SocConsolePage } from '../pages/SocConsolePage';
import { Api, TOKENS, type Role } from './api';

interface Fixtures {
  api: Api;
  dashboard: DashboardPage;
  commandCenter: CommandCenterPage;
  approvals: ApprovalQueuePage;
  socConsole: SocConsolePage;
  signedInAs: (role: Role) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern
  api: async ({}, use) => {
    const api = await Api.create();
    await use(api);
    await api.dispose();
  },
  dashboard: async ({ page }, use) => use(new DashboardPage(page)),
  commandCenter: async ({ page }, use) => use(new CommandCenterPage(page)),
  approvals: async ({ page }, use) => use(new ApprovalQueuePage(page)),
  socConsole: async ({ page }, use) => use(new SocConsolePage(page)),
  signedInAs: async ({ page }, use) => {
    await use(async (role) => {
      await page.addInitScript((token) => {
        window.sessionStorage.setItem('signalops.reviewerToken', token);
      }, TOKENS[role]);
    });
  },
});

export { expect } from '@playwright/test';
export { TOKENS };
