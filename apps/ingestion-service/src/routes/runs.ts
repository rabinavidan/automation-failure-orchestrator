import { Router } from 'express';
import { WebhookPayloadSchema } from '@orchestrator/shared-types';
import { query } from '../db/client';
import { processRun } from '../services/run-processor';
import { webhookSecret } from '../middleware/webhook-secret';

const router = Router();

// POST /api/runs — ingest a test run
router.post('/', webhookSecret, async (req, res) => {
  const parsed = WebhookPayloadSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid payload',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const result = await processRun(parsed.data);
    const statusCode = result.duplicateRun ? 200 : 201;
    res.status(statusCode).json(result);
  } catch (err) {
    console.error('[Runs] Processing error:', err);
    res.status(500).json({ error: 'Internal server error processing run' });
  }
});

// GET /api/runs — list recent runs
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const offset = parseInt(String(req.query.offset ?? '0'), 10);

  try {
    const runs = await query<{
      run_id: string;
      repository: string;
      branch: string;
      environment: string;
      summary: object;
      created_at: string;
    }>(
      `SELECT run_id, repository, branch, commit_sha, environment, triggered_by,
              started_at, finished_at, summary, created_at
       FROM test_runs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM test_runs'
    );

    res.json({
      runs,
      total: parseInt(total[0]?.count ?? '0', 10),
      limit,
      offset,
    });
  } catch (err) {
    console.error('[Runs] List error:', err);
    res.status(500).json({ error: 'Failed to list runs' });
  }
});

// GET /api/runs/:runId — get specific run with results
router.get('/:runId', async (req, res) => {
  const { runId } = req.params;

  try {
    const runs = await query<{ run_id: string }>(
      'SELECT * FROM test_runs WHERE run_id = $1',
      [runId]
    );

    if (runs.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const results = await query(
      'SELECT * FROM test_results WHERE run_id = $1 ORDER BY created_at ASC',
      [runId]
    );

    res.json({ run: runs[0], results });
  } catch (err) {
    console.error('[Runs] Get error:', err);
    res.status(500).json({ error: 'Failed to get run' });
  }
});

export default router;
