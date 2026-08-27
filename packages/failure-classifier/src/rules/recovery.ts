import type { FailureHistory } from '@orchestrator/shared-types';

const DEFAULT_RECOVERY_THRESHOLD = 3;

/**
 * A test is considered possibly fixed if it has passed consecutively
 * for at least `threshold` runs after previously having a linked Jira issue.
 */
export function isPossiblyFixed(
  history: FailureHistory,
  threshold: number = DEFAULT_RECOVERY_THRESHOLD
): boolean {
  return history.jiraIssueKey !== undefined && history.consecutivePasses >= threshold;
}
