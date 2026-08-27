import { FailureClassification } from '@orchestrator/shared-types';
import type {
  WebhookPayload,
  TestResult,
  FailureHistory,
  ProcessingResult,
  FailureSummary,
  AgentInvestigation,
} from '@orchestrator/shared-types';
import { generateFingerprint, fingerprintLabel } from '@orchestrator/fingerprint-engine';
import { classify } from '@orchestrator/failure-classifier';
import { query } from '../db/client';
import { searchByLabel, createIssue, addComment } from './jira-adapter';
import { sendSlackNotification } from './slack-adapter';
import { investigateFailure } from './failure-investigation-agent';
import { createApprovalRequest } from './approval-requests';

const RECOVERY_THRESHOLD = parseInt(process.env.RECOVERY_PASS_THRESHOLD ?? '3', 10);

export async function processRun(payload: WebhookPayload): Promise<ProcessingResult> {
  const { runId } = payload;

  // Check for duplicate run (idempotency)
  const existing = await query<{ run_id: string }>(
    'SELECT run_id FROM test_runs WHERE run_id = $1',
    [runId]
  );

  if (existing.length > 0) {
    console.log(`[Processor] Duplicate run ${runId}, skipping`);
    return {
      runId,
      processed: 0,
      skipped: payload.tests.length,
      failures: [],
      duplicateRun: true,
    };
  }

  // Persist the test run
  await query(
    `INSERT INTO test_runs (run_id, repository, branch, commit_sha, environment, triggered_by, started_at, finished_at, report_url, schema_version, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      runId,
      payload.repository,
      payload.branch,
      payload.commitSha,
      payload.environment,
      payload.triggeredBy,
      payload.startedAt,
      payload.finishedAt,
      payload.reportUrl ?? null,
      payload.schemaVersion,
      JSON.stringify(payload.summary),
    ]
  );

  const failures: FailureSummary[] = [];
  let processed = 0;
  let skipped = 0;

  for (const test of payload.tests) {
    try {
      if (test.status === 'skipped') {
        skipped++;
        continue;
      }

      await processTest(test, payload, failures);
      processed++;
    } catch (err) {
      console.error(`[Processor] Error processing test ${test.testId}:`, err);
      // Don't lose data — still count as processed but log the error
      processed++;
    }
  }

  return { runId, processed, skipped, failures };
}

async function processTest(
  test: TestResult,
  payload: WebhookPayload,
  failures: FailureSummary[]
): Promise<void> {
  // For passed tests, check recovery
  if (test.status === 'passed') {
    await handlePassedTest(test, payload);
    await persistTestResult(test, payload.runId, null, null, null, undefined);
    return;
  }

  // Generate fingerprint for failed tests
  const fp = generateFingerprint({
    testId: test.testId,
    service: test.metadata?.service,
    errorName: test.error?.name ?? 'Error',
    errorMessage: test.error?.message ?? 'Unknown error',
    endpoint: test.metadata?.endpoint,
  });

  const label = fingerprintLabel(fp);

  // Look up existing Jira issue by fingerprint label
  const existingIssue = await searchByLabel(label);

  // Get failure history
  const history = await getFailureHistory(fp);

  // Classify the failure
  const classification = classify({
    test,
    failureHistory: history ?? undefined,
    existingJiraIssue: existingIssue?.key,
  });

  // The agent may gather evidence and recommend an action, but deterministic
  // classification remains the policy guardrail for side effects.
  const investigationOutcome = await investigateFailure({
    test,
    run: payload,
    fingerprint: fp,
    deterministicClassification: classification,
    history,
    existingIssue,
  });
  const agentInvestigation = investigationOutcome.investigation;

  if (investigationOutcome.approvalPending && investigationOutcome.threadId && agentInvestigation) {
    await createApprovalRequest({
      threadId: investigationOutcome.threadId,
      fingerprint: fp,
      classification,
      context: { test, run: payload },
      investigation: agentInvestigation,
    });
    await upsertFailureHistory(fp, test, classification);
    await persistTestResult(test, payload.runId, fp, classification, null, agentInvestigation);
    failures.push({
      testId: test.testId,
      title: test.title,
      fingerprint: fp,
      classification,
      slackSent: false,
      agentInvestigation,
      approval: { threadId: investigationOutcome.threadId, status: 'pending' },
    });
    return;
  }

  let jiraKey: string | undefined;
  let slackSent = false;

  // Take action based on classification
  switch (classification) {
    case FailureClassification.NewRegression: {
      jiraKey = (await handleNewRegression(test, payload, fp, label)) ?? undefined;
      slackSent = await sendSlackNotification({
        classification,
        testTitle: test.title,
        suite: test.suite,
        fingerprint: fp,
        jiraKey,
        runId: payload.runId,
        branch: payload.branch,
        environment: payload.environment,
        errorMessage: test.error?.message,
        agentSummary: agentInvestigation?.explanation,
        agentConfidence: agentInvestigation?.confidence,
      });
      break;
    }

    case FailureClassification.KnownBug: {
      jiraKey = existingIssue?.key;
      if (jiraKey) {
        await handleKnownBug(test, payload, jiraKey, fp);
      }
      slackSent = await sendSlackNotification({
        classification,
        testTitle: test.title,
        suite: test.suite,
        fingerprint: fp,
        jiraKey,
        runId: payload.runId,
        branch: payload.branch,
        environment: payload.environment,
        errorMessage: test.error?.message,
        agentSummary: agentInvestigation?.explanation,
        agentConfidence: agentInvestigation?.confidence,
      });
      break;
    }

    default: {
      // Flaky, Infra, Automation — Slack only
      slackSent = await sendSlackNotification({
        classification,
        testTitle: test.title,
        suite: test.suite,
        fingerprint: fp,
        runId: payload.runId,
        branch: payload.branch,
        environment: payload.environment,
        errorMessage: test.error?.message,
        agentSummary: agentInvestigation?.explanation,
        agentConfidence: agentInvestigation?.confidence,
      });
      break;
    }
  }

  // Update failure history
  await upsertFailureHistory(fp, test, classification, jiraKey);

  // Persist test result
  await persistTestResult(
    test,
    payload.runId,
    fp,
    classification,
    jiraKey ?? null,
    agentInvestigation
  );

  failures.push({
    testId: test.testId,
    title: test.title,
    fingerprint: fp,
    classification,
    jiraKey,
    slackSent,
    agentInvestigation,
  });
}

async function handlePassedTest(test: TestResult, payload: WebhookPayload): Promise<void> {
  // Look for existing failure history for this test
  const fp = generateFingerprint({
    testId: test.testId,
    service: test.metadata?.service,
    errorName: 'Error', // Use generic for pass lookups
    errorMessage: '',
    endpoint: test.metadata?.endpoint,
  });

  const histories = await query<{
    fingerprint: string;
    consecutive_passes: number;
    jira_issue_key: string | null;
  }>(
    'SELECT fingerprint, consecutive_passes, jira_issue_key FROM failure_history WHERE test_id = $1',
    [test.testId]
  );

  for (const row of histories) {
    const newConsecutivePasses = row.consecutive_passes + 1;
    await query(
      `UPDATE failure_history
       SET consecutive_passes = $1,
           last_statuses = (last_statuses || $2::jsonb) - 0,
           last_seen_at = NOW()
       WHERE fingerprint = $3`,
      [newConsecutivePasses, JSON.stringify('passed'), row.fingerprint]
    );

    // Notify if recovery threshold met
    if (row.jira_issue_key && newConsecutivePasses >= RECOVERY_THRESHOLD) {
      await sendSlackNotification({
        classification: FailureClassification.PossiblyFixed,
        testTitle: test.title,
        suite: test.suite,
        fingerprint: row.fingerprint,
        jiraKey: row.jira_issue_key,
        runId: payload.runId,
        branch: payload.branch,
        environment: payload.environment,
      });
      await addComment(
        row.jira_issue_key,
        `Test may be fixed: passed ${newConsecutivePasses} consecutive runs as of run ${payload.runId}`
      );
    }
  }

  void fp; // unused but computed for structure
}

async function handleNewRegression(
  test: TestResult,
  payload: WebhookPayload,
  fingerprint: string,
  label: string
): Promise<string | null> {
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
    labels: [label, 'automated-test', `env-${payload.environment}`],
    priority: test.metadata?.severity === 'critical' ? 'Critical' : 'Medium',
  });
}

async function handleKnownBug(
  test: TestResult,
  payload: WebhookPayload,
  jiraKey: string,
  fingerprint: string
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

  await addComment(jiraKey, comment);
}

async function getFailureHistory(fingerprint: string): Promise<FailureHistory | null> {
  const rows = await query<{
    fingerprint: string;
    run_count: number;
    last_statuses: Array<'passed' | 'failed' | 'skipped'>;
    consecutive_passes: number;
    jira_issue_key: string | null;
  }>('SELECT * FROM failure_history WHERE fingerprint = $1', [fingerprint]);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    fingerprint: row.fingerprint,
    runCount: row.run_count,
    lastStatuses: row.last_statuses,
    consecutivePasses: row.consecutive_passes,
    jiraIssueKey: row.jira_issue_key ?? undefined,
  };
}

async function upsertFailureHistory(
  fingerprint: string,
  test: TestResult,
  classification: FailureClassification,
  jiraKey?: string
): Promise<void> {
  const status = test.status;
  const consecutivePasses = status === 'passed' ? 1 : 0;

  await query(
    `INSERT INTO failure_history
      (fingerprint, test_id, title, suite, run_count, fail_count, pass_count, last_statuses, consecutive_passes, jira_issue_key)
     VALUES ($1, $2, $3, $4, 1,
       CASE WHEN $5 = 'failed' THEN 1 ELSE 0 END,
       CASE WHEN $5 = 'passed' THEN 1 ELSE 0 END,
       $6::jsonb,
       $7,
       $8
     )
     ON CONFLICT (fingerprint) DO UPDATE SET
       run_count = failure_history.run_count + 1,
       fail_count = failure_history.fail_count + CASE WHEN $5 = 'failed' THEN 1 ELSE 0 END,
       pass_count = failure_history.pass_count + CASE WHEN $5 = 'passed' THEN 1 ELSE 0 END,
       last_statuses = (
         CASE
           WHEN jsonb_array_length(failure_history.last_statuses) >= 5
           THEN (failure_history.last_statuses - 0) || $6::jsonb
           ELSE failure_history.last_statuses || $6::jsonb
         END
       ),
       consecutive_passes = CASE WHEN $5 = 'passed' THEN failure_history.consecutive_passes + 1 ELSE 0 END,
       jira_issue_key = COALESCE($8, failure_history.jira_issue_key),
       last_seen_at = NOW()`,
    [
      fingerprint,
      test.testId,
      test.title,
      test.suite,
      status,
      JSON.stringify([status]),
      consecutivePasses,
      jiraKey ?? null,
    ]
  );
}

async function persistTestResult(
  test: TestResult,
  runId: string,
  fingerprint: string | null,
  classification: FailureClassification | null,
  jiraKey: string | null,
  agentInvestigation: AgentInvestigation | undefined
): Promise<void> {
  await query(
    `INSERT INTO test_results
      (run_id, test_id, title, suite, file, owner, status, duration_ms, retry,
       fingerprint, classification, error_name, error_message, error_stack,
       metadata, artifacts, jira_issue_key, agent_investigation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      runId,
      test.testId,
      test.title,
      test.suite,
      test.file,
      test.owner ?? null,
      test.status,
      test.durationMs,
      test.retry,
      fingerprint,
      classification,
      test.error?.name ?? null,
      test.error?.message ?? null,
      test.error?.stack ?? null,
      test.metadata ? JSON.stringify(test.metadata) : null,
      test.artifacts ? JSON.stringify(test.artifacts) : null,
      jiraKey,
      agentInvestigation ? JSON.stringify(agentInvestigation) : null,
    ]
  );
}

export async function executeApprovedFailureActions(input: {
  test: TestResult;
  payload: WebhookPayload;
  fingerprint: string;
  classification: FailureClassification;
  agentInvestigation: AgentInvestigation;
}): Promise<{ jiraKey?: string; slackSent: boolean }> {
  const label = fingerprintLabel(input.fingerprint);
  const existingIssue = await searchByLabel(label);
  let jiraKey: string | undefined;
  let slackSent = false;

  if (input.classification === FailureClassification.NewRegression) {
    jiraKey =
      (await handleNewRegression(input.test, input.payload, input.fingerprint, label)) ?? undefined;
  } else if (input.classification === FailureClassification.KnownBug) {
    jiraKey = existingIssue?.key;
    if (jiraKey) await handleKnownBug(input.test, input.payload, jiraKey, input.fingerprint);
  }

  slackSent = await sendSlackNotification({
    classification: input.classification,
    testTitle: input.test.title,
    suite: input.test.suite,
    fingerprint: input.fingerprint,
    jiraKey,
    runId: input.payload.runId,
    branch: input.payload.branch,
    environment: input.payload.environment,
    errorMessage: input.test.error?.message,
    agentSummary: input.agentInvestigation.explanation,
    agentConfidence: input.agentInvestigation.confidence,
  });

  if (jiraKey) {
    await query(`UPDATE failure_history SET jira_issue_key = $2 WHERE fingerprint = $1`, [
      input.fingerprint,
      jiraKey,
    ]);
    await query(
      `UPDATE test_results SET jira_issue_key = $3
       WHERE run_id = $1 AND fingerprint = $2`,
      [input.payload.runId, input.fingerprint, jiraKey]
    );
  }
  return { jiraKey, slackSent };
}
