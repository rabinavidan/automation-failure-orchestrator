import type { TestResult, FailureHistory } from '@orchestrator/shared-types';

/**
 * A test is flaky if:
 * 1. It has retry > 0 (meaning it failed at least once before possibly passing), OR
 * 2. Its failure history shows >= 2 status transitions in the last FLAKY_HISTORY_WINDOW runs
 */
export function isFlakyTest(test: TestResult, history?: FailureHistory): boolean {
  // Retry-based detection: test was retried
  if (test.retry > 0) {
    return true;
  }

  // History-based detection: frequent status transitions
  if (history && history.lastStatuses.length >= 2) {
    const window = history.lastStatuses.slice(-5);
    let transitions = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i] !== window[i - 1]) {
        transitions++;
      }
    }
    if (transitions >= 2) {
      return true;
    }
  }

  return false;
}
