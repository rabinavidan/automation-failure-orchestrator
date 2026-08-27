import { Router } from 'express';
import { z } from 'zod';
import { FailureClassification } from '@orchestrator/shared-types';
import { query } from '../db/client';
import {
  decideApprovalRequest,
  getApprovalRequest,
  restorePendingApproval,
} from '../services/approval-requests';
import { resumeFailureInvestigation } from '../services/failure-investigation-agent';
import { executeApprovedFailureActions } from '../services/run-processor';

const router = Router();

router.get('/', async (req, res) => {
  const status = String(req.query.status ?? 'pending');
  const allowedStatuses = ['pending', 'approved', 'rejected'];
  if (!allowedStatuses.includes(status)) {
    res.status(400).json({ error: 'Invalid approval status' });
    return;
  }
  try {
    const approvals = await query(
      `SELECT id, thread_id, run_id, fingerprint, test_id, classification,
              requested_action, status, investigation, reviewer, review_comment,
              created_at, decided_at
       FROM approval_requests
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [status]
    );
    res.json({ approvals });
  } catch (error) {
    console.error('[Approvals] List error:', error);
    res.status(500).json({ error: 'Failed to list approvals' });
  }
});

const DecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewer: z.string().trim().min(1).max(120),
  comment: z.string().trim().max(1000).optional(),
});

router.post('/:threadId/decision', async (req, res) => {
  const parsed = DecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid decision', details: parsed.error.flatten() });
    return;
  }
  const threadId = decodeURIComponent(req.params.threadId);
  const current = await getApprovalRequest(threadId);
  if (!current) {
    res.status(404).json({ error: 'Approval request not found' });
    return;
  }
  if (current.status !== 'pending') {
    res.status(409).json({ error: 'Approval request already decided', status: current.status });
    return;
  }

  const decision = await decideApprovalRequest({
    threadId,
    decision: parsed.data.decision,
    reviewer: parsed.data.reviewer,
    comment: parsed.data.comment,
  });
  if (!decision) {
    res.status(409).json({ error: 'Approval request was decided concurrently' });
    return;
  }

  let resumed: Awaited<ReturnType<typeof resumeFailureInvestigation>>;
  try {
    resumed = await resumeFailureInvestigation({
      threadId,
      approved: parsed.data.decision === 'approved',
      reviewer: parsed.data.reviewer,
      comment: parsed.data.comment,
    });
  } catch (error) {
    await restorePendingApproval(threadId);
    console.error('[Approvals] Resume error:', error);
    res.status(500).json({ error: 'Failed to resume approval; request restored to pending' });
    return;
  }

  let actions: { jiraKey?: string; slackSent: boolean } | undefined;
  if (resumed.status === 'approved') {
    try {
      actions = await executeApprovedFailureActions({
        test: decision.context.test,
        payload: decision.context.run,
        fingerprint: decision.fingerprint,
        classification: decision.classification as FailureClassification,
        agentInvestigation: decision.investigation,
      });
    } catch (error) {
      console.error('[Approvals] Approved action execution error:', error);
      res.status(502).json({
        error: 'Approval resumed, but an external action failed',
        threadId,
        status: resumed.status,
      });
      return;
    }
  }
  res.json({ threadId, status: resumed.status, actions });
});

export default router;
