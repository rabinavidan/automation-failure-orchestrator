import { type Locator, type Page } from '@playwright/test';

/** CI approval queue and the reviewer sign-in form. */
export class ApprovalQueuePage {
  readonly tokenInput: Locator;
  readonly signInButton: Locator;
  readonly signOutButton: Locator;
  readonly signInError: Locator;

  constructor(readonly page: Page) {
    this.tokenInput = page.getByLabel('Reviewer token');
    this.signInButton = page.getByRole('button', { name: 'Sign in' });
    this.signOutButton = page.getByRole('button', { name: 'Sign out' });
    this.signInError = page.getByRole('alert');
  }

  card(threadId: string): Locator {
    return this.page.locator(`[data-testid="approval-card"][data-thread-id="${threadId}"]`);
  }

  approveButton(threadId: string): Locator {
    return this.card(threadId).getByRole('button', { name: 'Approve & resume' });
  }

  rejectButton(threadId: string): Locator {
    return this.card(threadId).getByRole('button', { name: 'Reject' });
  }

  async signIn(token: string): Promise<void> {
    await this.tokenInput.fill(token);
    await this.signInButton.click();
  }
}
