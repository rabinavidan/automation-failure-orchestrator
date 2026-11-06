import { expect, test } from '../support/fixtures';

test.describe('knowledge RAG', () => {
  test('index status is reported from the API, including an empty index', async ({
    dashboard,
    page,
  }) => {
    const status = await (await page.request.get('/api/ingestion/api/knowledge/status')).json();

    await dashboard.open();
    await dashboard.goTo('Knowledge RAG');

    await expect(dashboard.metric('Indexed chunks')).toHaveText(String(status.chunkCount));
    await expect(dashboard.metric('Sources')).toHaveText(String(status.sourceCount));
    await expect(dashboard.metric('Embedding')).toHaveText(
      status.latestRun?.status ?? 'not indexed'
    );
  });

  test('a query shorter than three characters is not sent', async ({
    dashboard,
    knowledge,
    page,
  }) => {
    let searches = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/knowledge/search')) searches += 1;
    });
    await dashboard.open();
    await dashboard.goTo('Knowledge RAG');

    await knowledge.search('ab');

    await expect(knowledge.searchButton).toBeEnabled();
    expect(searches).toBe(0);
  });

  test('a failed search shows the degraded banner and keeps the page usable', async ({
    dashboard,
    knowledge,
    page,
  }) => {
    await page.route('**/api/knowledge/search', (route) => route.fulfill({ status: 500 }));
    await dashboard.open();
    await dashboard.goTo('Knowledge RAG');

    await knowledge.search('why does checkout retry');

    await expect(dashboard.degradedBanner).toBeVisible();
    await expect(page.getByText('Knowledge search failed')).toBeVisible();
    await expect(knowledge.searchButton).toBeEnabled();
  });
});
