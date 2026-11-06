import { expect, test } from '../support/fixtures';

test.describe('AI observability', () => {
  test('a new investigation is counted, and its model calls are listed by node', async ({
    api,
    dashboard,
    observability,
  }) => {
    await dashboard.open();
    await dashboard.goTo('AI observability');
    const before = Number(await dashboard.metric('Model calls').textContent());

    await api.failureWithInvestigation();
    await dashboard.refresh();

    // Three specialists and the supervisor each call the model once.
    await expect
      .poll(async () => Number(await dashboard.metric('Model calls').textContent()))
      .toBeGreaterThanOrEqual(before + 4);
    await expect(observability.recentCalls.getByText(/demo-stub/).first()).toBeVisible();
    await expect(
      observability.nodePerformance.getByText('supervisor', { exact: true })
    ).toBeVisible();
  });
});

test.describe('benchmark', () => {
  test('the deterministic baseline makes no model-quality claim', async ({
    dashboard,
    observability,
  }) => {
    await dashboard.open();
    await dashboard.goTo('AI observability');
    const baseline = observability.report('signalops-investigation-benchmark@1.1.0 · 35 cases');

    await expect(baseline.getByText('none (deterministic only)')).toBeVisible();
    await expect(
      baseline.getByText(
        'Agent configurations not run in this report: no real-model quality claim.'
      )
    ).toBeVisible();
    const tracks = baseline.getByRole('table', {
      name: 'Deterministic decision quality by track',
    });
    await expect(tracks.getByRole('cell', { name: 'ci', exact: true })).toBeVisible();
    await expect(tracks.getByRole('cell', { name: 'soc', exact: true })).toBeVisible();
  });

  test('real-model reports name the model and its backend', async ({
    dashboard,
    observability,
  }) => {
    await dashboard.open();
    await dashboard.goTo('AI observability');

    await expect(observability.benchmark.getByText('qwen3:4b (real)').first()).toBeVisible();
  });

  test('an unavailable benchmark says so instead of showing stale numbers', async ({
    dashboard,
    observability,
    page,
  }) => {
    await page.route('**/api/benchmark/summary', (route) => route.fulfill({ status: 503 }));
    await dashboard.open();
    await dashboard.goTo('AI observability');

    await expect(observability.benchmark.getByRole('alert')).toHaveText(
      'Benchmark summary unavailable.'
    );
    await expect(observability.benchmark.getByRole('table')).toHaveCount(0);
  });
});
