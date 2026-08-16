import { FailureClassification } from '@orchestrator/shared-types';
import type { ClassifyInput } from '@orchestrator/shared-types';
import { isInfrastructureFailure } from './rules/infrastructure';
import { isAutomationFailure } from './rules/automation';
import { isFlakyTest } from './rules/flaky';
import { isPossiblyFixed } from './rules/recovery';

export function classify(input: ClassifyInput): FailureClassification {
  const { test, failureHistory, existingJiraIssue } = input;

  // If a test passes and had a known bug, check for recovery
  if (test.status === 'passed' && failureHistory?.jiraIssueKey) {
    if (isPossiblyFixed(failureHistory)) {
      return FailureClassification.PossiblyFixed;
    }
  }

  // Known bug: existing Jira issue already tracks this fingerprint
  if (existingJiraIssue) {
    return FailureClassification.KnownBug;
  }

  const errorText = [
    test.error?.message ?? '',
    test.error?.name ?? '',
    test.error?.stack ?? '',
  ].join(' ');

  if (isInfrastructureFailure(errorText)) {
    return FailureClassification.InfrastructureFailure;
  }

  if (isAutomationFailure(errorText)) {
    return FailureClassification.AutomationFailure;
  }

  if (isFlakyTest(test, failureHistory)) {
    return FailureClassification.FlakyTest;
  }

  return FailureClassification.NewRegression;
}
