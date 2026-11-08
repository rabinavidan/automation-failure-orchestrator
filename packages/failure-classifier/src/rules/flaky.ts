import type { FailureHistory } from '@orchestrator/shared-types';

const FLAKY_WINDOW = 5;
const FLAKY_MIN_TRANSITIONS = 2;

/**
 * A failure is flaky across runs when its recent outcomes keep flipping: at least two
 * pass/fail transitions in the last five runs.
 *
 * Retries are deliberately not evidence here. A failed result with retry > 0 failed on every
 * attempt, which is a consistent failure, not a flaky one. Flakiness inside a single run
 * (failed, then passed on retry) is detected by the run processor from the final outcome.
 */
export function isFlakyTest(history?: FailureHistory): boolean {
  if (!history || history.lastStatuses.length < 2) return false;
  const window = history.lastStatuses.slice(-FLAKY_WINDOW);
  let transitions = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] !== window[i - 1]) transitions++;
  }
  return transitions >= FLAKY_MIN_TRANSITIONS;
}
