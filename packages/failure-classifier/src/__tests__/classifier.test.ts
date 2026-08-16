import { describe, it, expect } from 'vitest';
import { classify } from '../classifier';
import { isInfrastructureFailure } from '../rules/infrastructure';
import { isAutomationFailure } from '../rules/automation';
import { isFlakyTest } from '../rules/flaky';
import { isPossiblyFixed } from '../rules/recovery';
import { FailureClassification } from '@orchestrator/shared-types';
import type { TestResult, FailureHistory } from '@orchestrator/shared-types';

const makeTest = (overrides: Partial<TestResult> = {}): TestResult => ({
  testId: 'test-1',
  title: 'Test Title',
  suite: 'Test Suite',
  file: 'tests/example.spec.ts',
  status: 'failed',
  durationMs: 1000,
  retry: 0,
  ...overrides,
});

const makeHistory = (overrides: Partial<FailureHistory> = {}): FailureHistory => ({
  fingerprint: 'abc123',
  runCount: 5,
  lastStatuses: ['failed', 'failed', 'failed'],
  consecutivePasses: 0,
  ...overrides,
});

describe('isInfrastructureFailure', () => {
  it('detects ECONNREFUSED', () => {
    expect(isInfrastructureFailure('connect ECONNREFUSED 127.0.0.1:5432')).toBe(true);
  });

  it('detects ENOTFOUND', () => {
    expect(isInfrastructureFailure('getaddrinfo ENOTFOUND api.example.com')).toBe(true);
  });

  it('detects connection refused', () => {
    expect(isInfrastructureFailure('Error: connection refused')).toBe(true);
  });

  it('detects gateway timeout', () => {
    expect(isInfrastructureFailure('502 gateway timeout')).toBe(true);
  });

  it('detects 503 status', () => {
    expect(isInfrastructureFailure('Service returned 503')).toBe(true);
  });

  it('detects browser launch failure', () => {
    expect(isInfrastructureFailure('Failed to launch browser chromium')).toBe(true);
  });

  it('detects ETIMEDOUT', () => {
    expect(isInfrastructureFailure('connect ETIMEDOUT')).toBe(true);
  });

  it('detects ECONNRESET', () => {
    expect(isInfrastructureFailure('socket hang up ECONNRESET')).toBe(true);
  });

  it('does not flag regular test failures', () => {
    expect(isInfrastructureFailure('Expected 200 but got 404')).toBe(false);
  });
});

describe('isAutomationFailure', () => {
  it('detects strict mode violation', () => {
    expect(isAutomationFailure('locator.click: strict mode violation')).toBe(true);
  });

  it('detects waiting for selector', () => {
    expect(isAutomationFailure('Timeout waiting for selector .btn')).toBe(true);
  });

  it('detects unknown fixture', () => {
    expect(isAutomationFailure('unknown fixture: myFixture')).toBe(true);
  });

  it('detects Cannot find module', () => {
    expect(isAutomationFailure('Cannot find module ./helper')).toBe(true);
  });

  it('detects SyntaxError', () => {
    expect(isAutomationFailure('SyntaxError: Unexpected token')).toBe(true);
  });

  it('detects beforeAll failed', () => {
    expect(isAutomationFailure('beforeAll hook failed')).toBe(true);
  });

  it('does not flag infra errors', () => {
    expect(isAutomationFailure('ECONNREFUSED')).toBe(false);
  });
});

describe('isFlakyTest', () => {
  it('detects flaky via retry count', () => {
    const test = makeTest({ retry: 1 });
    expect(isFlakyTest(test)).toBe(true);
  });

  it('detects flaky via history transitions', () => {
    const test = makeTest({ retry: 0 });
    const history = makeHistory({
      lastStatuses: ['failed', 'passed', 'failed', 'passed', 'failed'],
    });
    expect(isFlakyTest(test, history)).toBe(true);
  });

  it('does not flag consistent failures as flaky', () => {
    const test = makeTest({ retry: 0 });
    const history = makeHistory({
      lastStatuses: ['failed', 'failed', 'failed', 'failed', 'failed'],
    });
    expect(isFlakyTest(test, history)).toBe(false);
  });

  it('does not flag consistent passes as flaky', () => {
    const test = makeTest({ retry: 0, status: 'passed' });
    const history = makeHistory({
      lastStatuses: ['passed', 'passed', 'passed'],
    });
    expect(isFlakyTest(test, history)).toBe(false);
  });
});

describe('isPossiblyFixed', () => {
  it('detects recovery after threshold passes', () => {
    const history = makeHistory({
      jiraIssueKey: 'AUTO-123',
      consecutivePasses: 3,
    });
    expect(isPossiblyFixed(history, 3)).toBe(true);
  });

  it('does not flag recovery below threshold', () => {
    const history = makeHistory({
      jiraIssueKey: 'AUTO-123',
      consecutivePasses: 2,
    });
    expect(isPossiblyFixed(history, 3)).toBe(false);
  });

  it('does not flag recovery without jira issue', () => {
    const history = makeHistory({
      consecutivePasses: 5,
    });
    expect(isPossiblyFixed(history, 3)).toBe(false);
  });
});

describe('classify', () => {
  it('classifies known bug when existingJiraIssue provided', () => {
    const test = makeTest({
      error: { name: 'Error', message: 'Something failed' },
    });
    const result = classify({ test, existingJiraIssue: 'AUTO-100' });
    expect(result).toBe(FailureClassification.KnownBug);
  });

  it('classifies infrastructure failure', () => {
    const test = makeTest({
      error: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:5432' },
    });
    const result = classify({ test });
    expect(result).toBe(FailureClassification.InfrastructureFailure);
  });

  it('classifies automation failure', () => {
    const test = makeTest({
      error: { name: 'Error', message: 'strict mode violation: getByRole locator' },
    });
    const result = classify({ test });
    expect(result).toBe(FailureClassification.AutomationFailure);
  });

  it('classifies flaky test via retry', () => {
    const test = makeTest({
      retry: 1,
      error: { name: 'Error', message: 'Assertion failed' },
    });
    const result = classify({ test });
    expect(result).toBe(FailureClassification.FlakyTest);
  });

  it('classifies new regression by default', () => {
    const test = makeTest({
      error: { name: 'AssertionError', message: 'Expected 200, got 500' },
    });
    const result = classify({ test });
    expect(result).toBe(FailureClassification.NewRegression);
  });

  it('classifies possibly fixed when passed with jira issue and threshold met', () => {
    const test = makeTest({ status: 'passed' });
    const history = makeHistory({
      jiraIssueKey: 'AUTO-999',
      consecutivePasses: 3,
    });
    const result = classify({ test, failureHistory: history });
    expect(result).toBe(FailureClassification.PossiblyFixed);
  });
});
