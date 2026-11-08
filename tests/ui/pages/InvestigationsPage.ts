import type { Locator, Page } from '@playwright/test';

/** "AI investigations": one dossier per failure that an advisory agent investigated. */
export class InvestigationsPage {
  constructor(readonly page: Page) {}

  dossier(title: string): Locator {
    return this.page.getByRole('article').filter({ hasText: title });
  }

  specialist(dossier: Locator, agent: 'triage' | 'repository' | 'action'): Locator {
    return dossier.getByText(`${agent} agent`, { exact: true });
  }
}
