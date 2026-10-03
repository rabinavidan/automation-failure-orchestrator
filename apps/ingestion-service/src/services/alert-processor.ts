import type { PoolClient } from 'pg';
import { generateAlertFingerprint, alertFingerprintLabel } from '@orchestrator/fingerprint-engine';
import type {
  AlertProcessingResult,
  SecurityAlert,
  SecuritySeverity,
} from '@orchestrator/shared-types';
import { getPool } from '../db/client';

const DEFAULT_SUPPRESSION_WINDOW_MINUTES = 60;

export function suppressionWindowMinutes(): number {
  const raw = Number(process.env.ALERT_SUPPRESSION_WINDOW_MINUTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SUPPRESSION_WINDOW_MINUTES;
}

/**
 * Deterministic suppression decision. An alert is suppressed when the same
 * fingerprint was already seen within the window (either side, so late or
 * out-of-order deliveries are handled). A window of 0 disables suppression.
 */
export function decideAlertStatus(input: {
  previousLastSeenAt: Date | null;
  detectedAt: Date;
  windowMinutes: number;
}): 'new' | 'suppressed' {
  if (!input.previousLastSeenAt || input.windowMinutes <= 0) return 'new';
  const deltaMs = Math.abs(input.detectedAt.getTime() - input.previousLastSeenAt.getTime());
  return deltaMs <= input.windowMinutes * 60_000 ? 'suppressed' : 'new';
}

const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function maxSeverity(a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

interface FingerprintRow {
  occurrence_count: number;
  suppressed_count: number;
  max_severity: SecuritySeverity;
  first_seen_at: Date;
  last_seen_at: Date;
}

export async function processAlert(
  alert: SecurityAlert,
  windowMinutes: number = suppressionWindowMinutes()
): Promise<AlertProcessingResult> {
  const client = await getPool().connect();
  try {
    const existing = await findDuplicateDelivery(client, alert.alertId);
    if (existing) return existing;

    await client.query('BEGIN');
    try {
      const result = await processAlertInTransaction(client, alert, windowMinutes);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof ConcurrentDeliveryError) {
        const winner = await findDuplicateDelivery(client, alert.alertId);
        if (winner) return winner;
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

class ConcurrentDeliveryError extends Error {}

/** Idempotency: a retried webhook delivery carries the same alertId. */
async function findDuplicateDelivery(
  client: PoolClient,
  alertId: string
): Promise<AlertProcessingResult | null> {
  const rows = await client.query<FingerprintRow & { fingerprint: string }>(
    `SELECT af.fingerprint, af.occurrence_count, af.suppressed_count, af.max_severity,
            af.first_seen_at, af.last_seen_at
     FROM security_alerts sa
     JOIN alert_fingerprints af ON af.fingerprint = sa.fingerprint
     WHERE sa.alert_id = $1`,
    [alertId]
  );
  const row = rows.rows[0];
  return row ? toResult(alertId, row.fingerprint, 'duplicate_delivery', row) : null;
}

async function processAlertInTransaction(
  client: PoolClient,
  alert: SecurityAlert,
  windowMinutes: number
): Promise<AlertProcessingResult> {
  const fingerprint = generateAlertFingerprint({
    vendor: alert.source.vendor,
    ruleId: alert.ruleId,
    host: alert.host,
    user: alert.user,
    indicators: alert.indicators,
  });
  const detectedAt = new Date(alert.detectedAt);

  // 1. Make sure the aggregate row exists, then lock it. Inserting first (with
  //    occurrence_count = 0) makes concurrent first sightings serialize on the lock.
  await client.query(
    `INSERT INTO alert_fingerprints
       (fingerprint, vendor, rule_id, rule_name, host, user_name, max_severity,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (fingerprint) DO NOTHING`,
    [
      fingerprint,
      alert.source.vendor,
      alert.ruleId,
      alert.ruleName,
      alert.host ?? null,
      alert.user ?? null,
      alert.severity,
      detectedAt,
    ]
  );
  const locked = await client.query<FingerprintRow>(
    `SELECT occurrence_count, suppressed_count, max_severity, first_seen_at, last_seen_at
     FROM alert_fingerprints WHERE fingerprint = $1 FOR UPDATE`,
    [fingerprint]
  );
  const previous = locked.rows[0]!;

  // 2. Record the alert. A conflict here means a concurrent delivery of the same
  //    alertId won the race after our pre-check; roll back and report it as a duplicate.
  const inserted = await client.query(
    `INSERT INTO security_alerts
       (alert_id, fingerprint, vendor, rule_id, title, severity, status, host, user_name,
        indicators, mitre, alert, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12)
     ON CONFLICT (alert_id) DO NOTHING
     RETURNING id`,
    [
      alert.alertId,
      fingerprint,
      alert.source.vendor,
      alert.ruleId,
      alert.title,
      alert.severity,
      alert.host ?? null,
      alert.user ?? null,
      JSON.stringify(alert.indicators),
      alert.mitre ? JSON.stringify(alert.mitre) : null,
      JSON.stringify(alert),
      detectedAt,
    ]
  );

  if (inserted.rowCount === 0) {
    throw new ConcurrentDeliveryError(alert.alertId);
  }

  // 3. Deterministic suppression decision, then update the aggregate.
  const status = decideAlertStatus({
    previousLastSeenAt: previous.occurrence_count > 0 ? previous.last_seen_at : null,
    detectedAt,
    windowMinutes,
  });

  const updated = await client.query<FingerprintRow>(
    `UPDATE alert_fingerprints SET
       occurrence_count = occurrence_count + 1,
       suppressed_count = suppressed_count + $2,
       max_severity     = $3,
       last_alert_id    = $4,
       first_seen_at    = LEAST(first_seen_at, $5),
       last_seen_at     = GREATEST(last_seen_at, $5),
       updated_at       = NOW()
     WHERE fingerprint = $1
     RETURNING occurrence_count, suppressed_count, max_severity, first_seen_at, last_seen_at`,
    [
      fingerprint,
      status === 'suppressed' ? 1 : 0,
      maxSeverity(previous.max_severity, alert.severity),
      alert.alertId,
      detectedAt,
    ]
  );

  await client.query('UPDATE security_alerts SET status = $2 WHERE alert_id = $1', [
    alert.alertId,
    status,
  ]);

  return toResult(alert.alertId, fingerprint, status, updated.rows[0]!);
}

function toResult(
  alertId: string,
  fingerprint: string,
  status: AlertProcessingResult['status'],
  row: FingerprintRow
): AlertProcessingResult {
  return {
    alertId,
    fingerprint,
    fingerprintLabel: alertFingerprintLabel(fingerprint),
    status,
    occurrenceCount: row.occurrence_count,
    suppressedCount: row.suppressed_count,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}
