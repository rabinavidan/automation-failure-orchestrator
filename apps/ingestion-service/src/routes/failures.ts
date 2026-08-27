import { Router } from 'express';
import { z } from 'zod';
import { FailureClassification } from '@orchestrator/shared-types';
import { query } from '../db/client';

const router = Router();

// GET /api/failures — list failure history records
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const offset = parseInt(String(req.query.offset ?? '0'), 10);
  const classification = req.query.classification as string | undefined;

  try {
    let sql = `
      SELECT fh.*, tr.classification, tr.jira_issue_key, tr.agent_investigation,
             tr.test_result_created_at
      FROM failure_history fh
      LEFT JOIN (
        SELECT DISTINCT ON (fingerprint) fingerprint, classification, jira_issue_key,
               agent_investigation, created_at AS test_result_created_at
        FROM test_results
        WHERE fingerprint IS NOT NULL
        ORDER BY fingerprint, created_at DESC
      ) tr ON tr.fingerprint = fh.fingerprint
    `;
    const params: unknown[] = [limit, offset];

    if (classification) {
      sql += ` WHERE tr.classification = $3`;
      params.push(classification);
    }

    sql += ` ORDER BY fh.last_seen_at DESC LIMIT $1 OFFSET $2`;

    const failures = await query(sql, params);
    const total = await query<{ count: string }>('SELECT COUNT(*) as count FROM failure_history');

    res.json({
      failures,
      total: parseInt(total[0]?.count ?? '0', 10),
      limit,
      offset,
    });
  } catch (err) {
    console.error('[Failures] List error:', err);
    res.status(500).json({ error: 'Failed to list failures' });
  }
});

// GET /api/failures/:fingerprint — get failure history for specific fingerprint
router.get('/:fingerprint', async (req, res) => {
  const { fingerprint } = req.params;

  try {
    const history = await query('SELECT * FROM failure_history WHERE fingerprint = $1', [
      fingerprint,
    ]);

    if (history.length === 0) {
      res.status(404).json({ error: 'Failure history not found' });
      return;
    }

    const recentResults = await query(
      `SELECT test_id, title, status, classification, jira_issue_key,
              agent_investigation, created_at
       FROM test_results
       WHERE fingerprint = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [fingerprint]
    );

    res.json({ history: history[0], recentResults });
  } catch (err) {
    console.error('[Failures] Get error:', err);
    res.status(500).json({ error: 'Failed to get failure' });
  }
});

// GET /api/failures/:fingerprint/agent-executions — checkpoint-backed agent audit timeline
router.get('/:fingerprint/agent-executions', async (req, res) => {
  const { fingerprint } = req.params;

  try {
    const executions = await query<{
      thread_id: string;
      run_id: string;
      test_id: string;
      model: string;
      status: string;
      final_result: unknown;
      started_at: string;
      finished_at: string | null;
    }>(
      `SELECT thread_id, run_id, test_id, model, status, final_result, started_at, finished_at
       FROM agent_executions
       WHERE fingerprint = $1
       ORDER BY started_at DESC
       LIMIT 20`,
      [fingerprint]
    );

    if (executions.length === 0) {
      res.json({ executions: [] });
      return;
    }

    const events = await query<{
      id: string;
      thread_id: string;
      node: string;
      status: string;
      details: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT id, thread_id, node, status, details, created_at
       FROM agent_execution_events
       WHERE thread_id = ANY($1::text[])
       ORDER BY id ASC`,
      [executions.map((execution) => execution.thread_id)]
    );

    res.json({
      executions: executions.map((execution) => ({
        ...execution,
        events: events.filter((event) => event.thread_id === execution.thread_id),
      })),
    });
  } catch (err) {
    console.error('[Failures] Agent execution audit error:', err);
    res.status(500).json({ error: 'Failed to load agent execution audit' });
  }
});

const ReclassifySchema = z.object({
  classification: z.nativeEnum(FailureClassification),
  reason: z.string().optional(),
});

// POST /api/failures/:fingerprint/reclassify — manually reclassify
router.post('/:fingerprint/reclassify', async (req, res) => {
  const { fingerprint } = req.params;
  const parsed = ReclassifySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }

  try {
    const { classification } = parsed.data;

    // Update the most recent test result for this fingerprint
    const updated = await query(
      `UPDATE test_results SET classification = $1
       WHERE id IN (
         SELECT id FROM test_results WHERE fingerprint = $2
         ORDER BY created_at DESC LIMIT 1
       )
       RETURNING id`,
      [classification, fingerprint]
    );

    if (updated.length === 0) {
      res.status(404).json({ error: 'No test results found for fingerprint' });
      return;
    }

    res.json({ ok: true, classification, updated: updated.length });
  } catch (err) {
    console.error('[Failures] Reclassify error:', err);
    res.status(500).json({ error: 'Failed to reclassify' });
  }
});

export default router;
