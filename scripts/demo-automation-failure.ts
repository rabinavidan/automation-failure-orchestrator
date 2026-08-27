/**
 * Demo: Automation Failure
 * "strict mode violation" error — test code issue, not app regression.
 * Expected: Classified as automation_failure, Slack notification only.
 */
import { sendRun, basePayload } from './demo-helpers';

async function main() {
  console.log('=== Demo: Automation Failure ===');
  console.log('Expected: Classified as automation_failure (strict mode violation), Slack only\n');

  const payload = {
    ...basePayload({ branch: 'feature/new-search-ui' }),
    summary: { total: 3, passed: 1, failed: 2, skipped: 0 },
    tests: [
      {
        testId: 'tests/ui/search.spec.ts::search-results-display',
        title: 'search results are displayed correctly',
        suite: 'Search UI',
        file: 'tests/ui/search.spec.ts',
        status: 'failed',
        durationMs: 2100,
        retry: 0,
        error: {
          name: 'Error',
          message:
            "locator.click: Error: strict mode violation: getByRole('button', { name: 'Search' }) resolved to 3 elements",
          stack:
            'Error: locator.click: strict mode violation: getByRole(\'button\', { name: \'Search\' }) resolved to 3 elements:\n    1) <button class="search-btn primary">Search</button>\n    2) <button class="search-btn secondary">Search</button>\n    3) <button class="modal-search-btn">Search</button>\n    at search.spec.ts:34:18',
        },
        metadata: {
          service: 'search-service',
          endpoint: '/search',
          severity: 'medium',
          tags: ['ui', 'search'],
        },
      },
      {
        testId: 'tests/ui/search.spec.ts::search-autocomplete',
        title: 'search autocomplete suggests results',
        suite: 'Search UI',
        file: 'tests/ui/search.spec.ts',
        status: 'failed',
        durationMs: 1500,
        retry: 0,
        error: {
          name: 'Error',
          message: "unknown fixture: 'mockSearchService' - Did you forget to install the fixture?",
          stack:
            "Error: unknown fixture: 'mockSearchService'\n    at search.spec.ts:12:3\n    at setupTest",
        },
        metadata: {
          service: 'search-service',
          severity: 'low',
        },
      },
      {
        testId: 'tests/ui/search.spec.ts::search-empty-query',
        title: 'empty search query shows helpful message',
        suite: 'Search UI',
        file: 'tests/ui/search.spec.ts',
        status: 'passed',
        durationMs: 345,
        retry: 0,
      },
    ],
  };

  await sendRun(payload);
}

main();
