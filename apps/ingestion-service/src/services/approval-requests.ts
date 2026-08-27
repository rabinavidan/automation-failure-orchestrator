import type { AgentInvestigation, TestResult, WebhookPayload } from '@orchestrator/shared-types';
import { query } from '../db/client';

export interface ApprovalContext {
  test: TestResult;
  run: WebhookPayload;
}

export interface ApprovalRequestRow {
  id: string;
  thread_id: string;
  run_id: string;
  fingerprint: string;
  test_id: string;
  classification: string;
  requested_action: string;
  status: 'pending' | 'approved' | 'rejected';
  context: ApprovalContext;
  investigation: AgentInvestigation;
  reviewer: string | null;
  review_comment: string | null;
  created_at: string;
  decided_at: string | null;
}

export async function createApprovalRequest(input: {
  threadId: string;
  fingerprint: string;
  classification: string;
  context: ApprovalContext;
  investigation: AgentInvestigation;
}): Promise<void> {
  await query(
    `INSERT INTO approval_requests
      (thread_id, run_id, fingerprint, test_id, classification, requested_action, context, investigation)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     ON CONFLICT (thread_id) DO NOTHING`,
    [
      input.threadId,
      input.context.run.runId,
      input.fingerprint,
      input.context.test.testId,
      input.classification,
      input.investigation.recommendedAction,
      JSON.stringify(input.context),
      JSON.stringify(input.investigation),
    ]
  );
}

export async function getApprovalRequest(threadId: string): Promise<ApprovalRequestRow | null> {
  const rows = await query<ApprovalRequestRow>(
    'SELECT * FROM approval_requests WHERE thread_id = $1',
    [threadId]
  );
  return rows[0] ?? null;
}

export async function decideApprovalRequest(input: {
  threadId: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  comment?: string;
}): Promise<ApprovalRequestRow | null> {
  const rows = await query<ApprovalRequestRow>(
    `UPDATE approval_requests
     SET status = $2, reviewer = $3, review_comment = $4, decided_at = NOW()
     WHERE thread_id = $1 AND status = 'pending'
     RETURNING *`,
    [input.threadId, input.decision, input.reviewer, input.comment ?? null]
  );
  return rows[0] ?? null;
}

export async function restorePendingApproval(threadId: string): Promise<void> {
  await query(
    `UPDATE approval_requests
     SET status = 'pending', reviewer = NULL, review_comment = NULL, decided_at = NULL
     WHERE thread_id = $1`,
    [threadId]
  );
}
