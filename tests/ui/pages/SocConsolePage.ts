import { expect, type Locator, type Page } from '@playwright/test';

/** SOC console: containment approval queue, active containment and the alert queue. */
export class SocConsolePage {
  readonly dispositionFilter: Locator;
  readonly alertDetail: Locator;

  constructor(readonly page: Page) {
    this.dispositionFilter = page.getByLabel('Filter by disposition');
    this.alertDetail = page.getByRole('dialog', { name: 'Alert detail' });
  }

  pendingAction(id: string): Locator {
    return this.page.locator(`[data-testid="containment-action"][data-action-id="${id}"]`);
  }

  activeContainment(id: string): Locator {
    return this.page.locator(`[data-testid="active-containment"][data-action-id="${id}"]`);
  }

  alertRow(alertId: string): Locator {
    return this.page.locator(`[data-testid="alert-row"][data-alert-id="${alertId}"]`);
  }

  async openAlert(alertId: string): Promise<void> {
    await this.alertRow(alertId).click();
    await expect(this.alertDetail).toBeVisible();
  }
}
