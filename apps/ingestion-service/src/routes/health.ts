import { Router } from 'express';
import { getPool } from '../db/client';

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    // Test DB connection
    await getPool().query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
    });
  } catch {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
    });
  }
});

export default router;
