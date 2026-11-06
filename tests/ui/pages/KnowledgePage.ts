import type { Locator, Page } from '@playwright/test';

/** "Knowledge RAG": index status, semantic search and reindexing. */
export class KnowledgePage {
  readonly query: Locator;
  readonly searchButton: Locator;
  readonly reindexButton: Locator;

  constructor(readonly page: Page) {
    this.query = page.getByPlaceholder('Search repository knowledge');
    this.searchButton = page.getByRole('button', { name: 'Semantic search' });
    this.reindexButton = page.getByRole('button', { name: 'Reindex repository' });
  }

  async search(text: string): Promise<void> {
    await this.query.fill(text);
    await this.searchButton.click();
  }
}
