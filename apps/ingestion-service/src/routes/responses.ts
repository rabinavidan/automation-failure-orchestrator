import { Router } from 'express';
import { z } from 'zod';
import { ResponseActionStatusSchema } from '@orchestrator/shared-types';
import { query } from '../db/client';
import { getPlaybooks } from '../services/playbooks';
import { decideResponseAction, rollbackResponseAction } from '../services/response-engine';

const router = Router();

// GET /api/responses/actions — approval queue / action history
router.get('/actions', async (req, res) => {
  const status = req.query.status as string | undefined;
  if (status && !ResponseActionStatusSchema.options.includes(status as never)) {
    res
      .status(400)
      .json({ error: `status must be one of: ${ResponseActionStatusSchema.options.join(', ')}` });
    return;
  }
  const alertId = req.query.alertId as string | undefined;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    params.push(status);
    conditions.push(`ra.status = $${params.length}`);
  }
  if (alertId) {
    params.push(alertId);
    conditions.push(`ra.alert_id = $${params.length}`);
  }
  try {
    const actions = await query(
      `SELECT ra.*, sa.title AS alert_title, sa.triage_priority, sa.host, sa.user_name
       FROM response_actions ra JOIN security_alerts sa ON sa.alert_id = ra.alert_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY ra.created_at DESC LIMIT 100`,
      params
    );
    res.json({ actions });
  } catch (err) {
    console.error('[Responses] List error:', err);
    res.status(500).json({ error: 'Failed to list response actions' });
  }
});

// GET /api/responses/actions/:id — action with its append-only audit trail
router.get('/actions/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: 'invalid action id' });
    return;
  }
  try {
    const actions = await query('SELECT * FROM response_actions WHERE id = $1', [req.params.id]);
    if (actions.length === 0) {
      res.status(404).json({ error: 'response action not found' });
      return;
    }
    const events = await query(
      'SELECT event, actor, details, created_at FROM response_action_events WHERE action_id = $1 ORDER BY id',
      [req.params.id]
    );
    res.json({ action: actions[0], events });
  } catch (err) {
    console.error('[Responses] Get error:', err);
    res.status(500).json({ error: 'Failed to load response action' });
  }
});

const DecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewer: z.string().trim().min(1).max(120),
  comment: z.string().trim().max(1000).optional(),
});

// POST /api/responses/actions/:id/decision — human approval gate for containment
router.post('/actions/:id/decision', async (req, res) => {
  const parsed = DecisionSchema.safeParse(req.body);
  if (!parsed.success || !/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid decision', details: parsed.error?.flatten() });
    return;
  }
  try {
    const outcome = await decideResponseAction({ id: req.params.id, ...parsed.data });
    if (!outcome.ok) {
      res.status(outcome.code).json({ error: outcome.error });
      return;
    }
    res.json(outcome);
  } catch (err) {
    console.error('[Responses] Decision error:', err);
    res.status(500).json({ error: 'Failed to apply decision' });
  }
});

const RollbackSchema = z.object({
  reviewer: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(1000),
});

// POST /api/responses/actions/:id/rollback — undo a reversible containment action
router.post('/actions/:id/rollback', async (req, res) => {
  const parsed = RollbackSchema.safeParse(req.body);
  if (!parsed.success || !/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid rollback request', details: parsed.error?.flatten() });
    return;
  }
  try {
    const outcome = await rollbackResponseAction({ id: req.params.id, ...parsed.data });
    if (!outcome.ok) {
      res.status(outcome.code).json({ error: outcome.error });
      return;
    }
    res.json(outcome);
  } catch (err) {
    console.error('[Responses] Rollback error:', err);
    res.status(500).json({ error: 'Failed to roll back action' });
  }
});

// GET /api/responses/playbooks — loaded playbooks and any rejected files
router.get('/playbooks', (_req, res) => {
  res.json(getPlaybooks());
});

export default router;
