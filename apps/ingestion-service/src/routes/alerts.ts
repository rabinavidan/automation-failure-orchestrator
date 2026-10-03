import { Router } from 'express';
import type { Response } from 'express';
import {
  SecurityAlertSchema,
  TriageDispositionSchema,
  TriagePrioritySchema,
} from '@orchestrator/shared-types';
import type { SecurityAlert } from '@orchestrator/shared-types';
import { query } from '../db/client';
import { processAlert } from '../services/alert-processor';
import { enrichIngestedAlert } from '../services/alert-enrichment';
import { getTriagePolicy, triageIngestedAlert } from '../services/alert-triage';
import { scheduleAlertInvestigation } from '../services/alert-investigation';
import { runResponsePlaybooks } from '../services/response-engine';
import { VENDOR_NORMALIZERS } from '../services/alert-normalizers';
import { webhookSecret } from '../middleware/webhook-secret';

const router = Router();

const ALERT_STATUSES = ['new', 'suppressed'] as const;
const DISPOSITIONS = TriageDispositionSchema.options;
const PRIORITIES = TriagePrioritySchema.options;

async function ingest(alert: SecurityAlert, res: Response): Promise<void> {
  try {
    const result = await processAlert(alert);
    // Runs after the ingestion transaction commits, so a slow or failing
    // enrichment service never holds locks or loses the alert.
    const enrichment = await enrichIngestedAlert(alert, result.status);
    const triage = await triageIngestedAlert(alert, result, enrichment.response);
    // Advisory AI runs after the response; it never changes the triage decision.
    const investigation = scheduleAlertInvestigation(
      triage ? { alert, result, triage, enrichment: enrichment.response } : null
    );
    // Deterministic playbooks: tickets/notifications run now, containment waits for approval.
    const response =
      triage && result.status === 'new'
        ? await runResponsePlaybooks({ alert, triage, fingerprint: result.fingerprint }).catch(
            (err) => {
              console.error('[Alerts] Response playbooks failed:', err);
              return undefined;
            }
          )
        : undefined;
    res.status(result.status === 'duplicate_delivery' ? 200 : 201).json({
      ...result,
      enrichment: enrichment.outcome,
      ...(triage ? { triage, investigation } : {}),
      ...(response ? { response } : {}),
    });
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

// POST /api/alerts/:vendor — ingest a native SIEM payload (splunk | sentinel | wazuh)
router.post('/:vendor', webhookSecret, async (req, res) => {
  const vendor = VENDOR_NORMALIZERS[req.params.vendor];
  if (!vendor) {
    res.status(404).json({
      error: `unknown SIEM vendor; supported: ${Object.keys(VENDOR_NORMALIZERS).join(', ')}`,
    });
    return;
  }
  const parsed = vendor.schema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: `Invalid ${vendor.label} payload`, details: parsed.error.flatten() });
    return;
  }

  // Re-validate the normalized output so vendor parsing bugs fail loudly at the edge.
  const normalized = SecurityAlertSchema.safeParse(vendor.normalize(parsed.data as never));
  if (!normalized.success) {
    res.status(422).json({
      error: `${vendor.label} payload could not be normalized`,
      details: normalized.error.flatten(),
    });
    return;
  }
  await ingest(normalized.data, res);
});

// GET /api/alerts — list recent alerts, filterable by status, disposition and priority
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;

  const filters: Array<[column: string, value: string | undefined, allowed: readonly string[]]> = [
    ['status', req.query.status as string | undefined, ALERT_STATUSES],
    ['triage_disposition', req.query.disposition as string | undefined, DISPOSITIONS],
    ['triage_priority', req.query.priority as string | undefined, PRIORITIES],
  ];
  const conditions: string[] = [];
  const filterParams: unknown[] = [];
  for (const [column, value, allowed] of filters) {
    if (value === undefined) continue;
    if (!allowed.includes(value)) {
      res.status(400).json({ error: `${column} must be one of: ${allowed.join(', ')}` });
      return;
    }
    filterParams.push(value);
    conditions.push(`${column} = $${filterParams.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const n = filterParams.length;
    const alerts = await query(
      `SELECT alert_id, fingerprint, vendor, rule_id, title, severity, status, host, user_name,
              indicators, mitre, enrichment_status, enrichment_verdict, triage_disposition,
              triage_priority, risk_score, ai_investigation_status, detected_at, received_at
       FROM security_alerts ${where}
       ORDER BY received_at DESC
       LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...filterParams, limit, offset]
    );
    const total = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM security_alerts ${where}`,
      filterParams
    );

    res.json({ alerts, total: parseInt(total[0]?.count ?? '0', 10), limit, offset });
  } catch (err) {
    console.error('[Alerts] List error:', err);
    res.status(500).json({ error: 'Failed to list alerts' });
  }
});

// GET /api/alerts/triage-policy — active policy version and entries (policy-as-code audit)
router.get('/triage-policy', (_req, res) => {
  const { policy, source, error } = getTriagePolicy();
  res.json({
    ...policy,
    source: source.split('/').slice(-2).join('/'),
    ...(error ? { error } : {}),
  });
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
