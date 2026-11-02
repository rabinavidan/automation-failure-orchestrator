import { expect, type Locator, type Page } from '@playwright/test';

/** Failure intelligence list and the failure dossier dialog. */
export class CommandCenterPage {
  readonly filter: Locator;
  readonly rows: Locator;
  readonly dossier: Locator;

  constructor(readonly page: Page) {
    this.filter = page.getByPlaceholder('Filter signals');
    this.rows = page.getByTestId('failure-row');
    this.dossier = page.getByRole('dialog', { name: /Failure dossier for/ });
  }

  row(fingerprint: string): Locator {
    return this.page.locator(`[data-testid="failure-row"][data-fingerprint="${fingerprint}"]`);
  }

  async openDossier(fingerprint: string): Promise<void> {
    await this.row(fingerprint).click();
    await expect(this.dossier).toBeVisible();
  }

  async closeDossier(): Promise<void> {
    await this.dossier.getByRole('button').first().click();
    await expect(this.dossier).toBeHidden();
  }
}
