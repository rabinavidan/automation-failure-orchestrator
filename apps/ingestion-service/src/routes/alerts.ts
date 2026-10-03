import { Router } from 'express';
import type { Response } from 'express';
import { SecurityAlertSchema, SplunkAlertWebhookSchema } from '@orchestrator/shared-types';
import type { SecurityAlert } from '@orchestrator/shared-types';
import { query } from '../db/client';
import { processAlert } from '../services/alert-processor';
import { normalizeSplunkAlert } from '../services/alert-normalizers/splunk';
import { webhookSecret } from '../middleware/webhook-secret';

const router = Router();

const ALERT_STATUSES = ['new', 'suppressed'] as const;

async function ingest(alert: SecurityAlert, res: Response): Promise<void> {
  try {
    const result = await processAlert(alert);
    res.status(result.status === 'duplicate_delivery' ? 200 : 201).json(result);
  } catch (err) {
    console.error('[Alerts] Processing error:', err);
    res.status(500).json({ error: 'Internal server error processing alert' });
  }
}

// POST /api/alerts — ingest an alert already in the normalized SecurityAlert contract
router.post('/', webhookSecret, async (req, res) => {
  const parsed = SecurityAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid alert', details: parsed.error.flatten() });
    return;
  }
  await ingest(parsed.data, res);
});

// POST /api/alerts/splunk — ingest a raw Splunk webhook alert action payload
router.post('/splunk', webhookSecret, async (req, res) => {
  const parsed = SplunkAlertWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'Invalid Splunk webhook payload', details: parsed.error.flatten() });
    return;
  }

  // Re-validate the normalized output so vendor parsing bugs fail loudly at the edge.
  const normalized = SecurityAlertSchema.safeParse(normalizeSplunkAlert(parsed.data));
  if (!normalized.success) {
    res.status(422).json({
      error: 'Splunk payload could not be normalized',
      details: normalized.error.flatten(),
    });
    return;
  }
  await ingest(normalized.data, res);
});

// GET /api/alerts — list recent alerts, optionally filtered by status
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
  const status = req.query.status as string | undefined;

  if (status && !ALERT_STATUSES.includes(status as (typeof ALERT_STATUSES)[number])) {
    res.status(400).json({ error: `status must be one of: ${ALERT_STATUSES.join(', ')}` });
    return;
  }

  try {
    const where = status ? 'WHERE status = $3' : '';
    const params: unknown[] = status ? [limit, offset, status] : [limit, offset];
    const alerts = await query(
      `SELECT alert_id, fingerprint, vendor, rule_id, title, severity, status, host, user_name,
              indicators, mitre, detected_at, received_at
       FROM security_alerts ${where}
       ORDER BY received_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );
    const total = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM security_alerts ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    );

    res.json({ alerts, total: parseInt(total[0]?.count ?? '0', 10), limit, offset });
  } catch (err) {
    console.error('[Alerts] List error:', err);
    res.status(500).json({ error: 'Failed to list alerts' });
  }
});

// GET /api/alerts/fingerprints/:fingerprint — aggregate + recent occurrences
router.get('/fingerprints/:fingerprint', async (req, res) => {
  try {
    const aggregate = await query('SELECT * FROM alert_fingerprints WHERE fingerprint = $1', [
      req.params.fingerprint,
    ]);
    if (aggregate.length === 0) {
      res.status(404).json({ error: 'Alert fingerprint not found' });
      return;
    }
    const occurrences = await query(
      `SELECT alert_id, title, severity, status, detected_at, received_at
       FROM security_alerts WHERE fingerprint = $1
       ORDER BY detected_at DESC LIMIT 50`,
      [req.params.fingerprint]
    );
    res.json({ fingerprint: aggregate[0], occurrences });
  } catch (err) {
    console.error('[Alerts] Fingerprint error:', err);
    res.status(500).json({ error: 'Failed to load alert fingerprint' });
  }
});

// GET /api/alerts/:alertId — full normalized alert
router.get('/:alertId', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM security_alerts WHERE alert_id = $1', [
      req.params.alertId,
    ]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ alert: rows[0] });
  } catch (err) {
    console.error('[Alerts] Get error:', err);
    res.status(500).json({ error: 'Failed to get alert' });
  }
});

export default router;
