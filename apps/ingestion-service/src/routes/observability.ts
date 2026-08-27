import { Router } from 'express';
import { query } from '../db/client';

const router = Router();

router.get('/summary', async (_req, res) => {
  try {
    const [executions] = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'paused')::int AS paused,
              COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
                FILTER (WHERE finished_at IS NOT NULL), 0)::float AS avg_duration_ms
       FROM agent_executions WHERE started_at >= NOW() - INTERVAL '24 hours'`
    );
    const [modelCalls] = await query(
      `SELECT COUNT(*)::int AS calls,
              COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
              COALESCE(AVG(duration_ms), 0)::float AS avg_call_duration_ms
       FROM agent_model_calls WHERE created_at >= NOW() - INTERVAL '24 hours'`
    );
    const byNode = await query(
      `SELECT node, COUNT(*)::int AS calls, AVG(duration_ms)::float AS avg_duration_ms,
              SUM(prompt_tokens)::int AS prompt_tokens, SUM(completion_tokens)::int AS completion_tokens
       FROM agent_model_calls WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY node ORDER BY node`
    );
    const recentCalls = await query(
      `SELECT id, thread_id, node, prompt_version, model, prompt_tokens,
              completion_tokens, duration_ms, created_at
       FROM agent_model_calls ORDER BY id DESC LIMIT 30`
    );
    res.json({ window: '24h', executions, modelCalls, byNode, recentCalls });
  } catch (error) {
    console.error('[Observability] Summary error:', error);
    res.status(500).json({ error: 'Failed to load agent observability' });
  }
});

export default router;
