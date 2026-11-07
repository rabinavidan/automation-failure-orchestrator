import {
  FailureClassification,
  type AgentInvestigation,
  type TestResult,
  type WebhookPayload,
} from '@orchestrator/shared-types';
import { fingerprintLabel } from '@orchestrator/fingerprint-engine';
import { addComment, createIssue } from './jira-adapter';
import { sendSlackNotification } from './slack-adapter';

/**
 * The CI track's action policy: which side effects a classified failure gets. This is the
 * single source of that policy. A run processed directly and a run executed after a human
 * approval both plan here and execute through `executeFailureActions`, so the two paths cannot
 * drift apart (the SOC track does the same with playbooks and the response engine).
 */
export type FailureAction =
  | { kind: 'jira.create_issue' }
  | { kind: 'jira.comment'; issueKey: string }
  | { kind: 'slack.notify' };

/** Pure and deterministic: the planned actions for one classified failure. */
export function planFailureActions(
  classification: FailureClassification,
  existingIssueKey?: string
): FailureAction[] {
  switch (classification) {
    case FailureClassification.NewRegression:
      return [{ kind: 'jira.create_issue' }, { kind: 'slack.notify' }];
    case FailureClassification.KnownBug:
      return existingIssueKey
        ? [{ kind: 'jira.comment', issueKey: existingIssueKey }, { kind: 'slack.notify' }]
        : [{ kind: 'slack.notify' }];
    default:
      // Flaky, infrastructure and automation failures: a notification, never an issue.
      return [{ kind: 'slack.notify' }];
  }
}

export interface FailureActionContext {
  test: TestResult;
  payload: WebhookPayload;
  fingerprint: string;
  classification: FailureClassification;
  agentInvestigation?: AgentInvestigation;
}

export interface FailureActionResult {
  jiraKey?: string;
  slackSent: boolean;
}

/** Executes a plan in order; the Slack message carries the issue created or commented on. */
export async function executeFailureActions(
  plan: FailureAction[],
  context: FailureActionContext
): Promise<FailureActionResult> {
  let jiraKey: string | undefined;
  let slackSent = false;
  for (const action of plan) {
    switch (action.kind) {
      case 'jira.create_issue':
        jiraKey = (await createRegressionIssue(context)) ?? undefined;
        break;
      case 'jira.comment':
        jiraKey = action.issueKey;
        await commentOnKnownBug(context, action.issueKey);
        break;
      case 'slack.notify':
        slackSent = await sendSlackNotification({
          classification: context.classification,
          testTitle: context.test.title,
          suite: context.test.suite,
          fingerprint: context.fingerprint,
          jiraKey,
          runId: context.payload.runId,
          branch: context.payload.branch,
          environment: context.payload.environment,
          errorMessage: context.test.error?.message,
          agentSummary: context.agentInvestigation?.explanation,
          agentConfidence: context.agentInvestigation?.confidence,
        });
        break;
    }
  }
  return { jiraKey, slackSent };
}

async function createRegressionIssue({
  test,
  payload,
  fingerprint,
}: FailureActionContext): Promise<string | null> {
  const description = [
    `*Automated Test Failure Report*`,
    ``,
    `*Test:* ${test.title}`,
    `*Suite:* ${test.suite}`,
    `*File:* ${test.file}`,
    `*Branch:* ${payload.branch}`,
    `*Environment:* ${payload.environment}`,
    `*Run ID:* ${payload.runId}`,
    `*Fingerprint:* \`${fingerprint}\``,
    ``,
    `*Error:*`,
    `{code}`,
    test.error?.message ?? 'Unknown error',
    `{code}`,
    ``,
    `*Stack Trace:*`,
    `{code}`,
    test.error?.stack ?? 'No stack trace',
    `{code}`,
  ].join('\n');

  return createIssue({
    summary: `[AUTO] ${test.suite}: ${test.title}`,
    description,
    labels: [fingerprintLabel(fingerprint), 'automated-test', `env-${payload.environment}`],
    priority: test.metadata?.severity === 'critical' ? 'Critical' : 'Medium',
  });
}

async function commentOnKnownBug(
  { test, payload, fingerprint }: FailureActionContext,
  issueKey: string
): Promise<void> {
  const comment = [
    `*Test failure recurred*`,
    ``,
    `Run: ${payload.runId}`,
    `Branch: ${payload.branch}`,
    `Environment: ${payload.environment}`,
    `Fingerprint: \`${fingerprint}\``,
    ``,
    `Error: ${test.error?.message ?? 'Unknown'}`,
  ].join('\n');

  await addComment(issueKey, comment);
}
