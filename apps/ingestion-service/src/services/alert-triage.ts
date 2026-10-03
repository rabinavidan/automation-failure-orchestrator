import { readFileSync } from 'fs';
import { join } from 'path';
import { TriagePolicySchema } from '@orchestrator/shared-types';
import type {
  AlertProcessingResult,
  AlertTriage,
  EnrichmentResponse,
  SecurityAlert,
  TriagePolicy,
} from '@orchestrator/shared-types';
import { triageAlert } from '@orchestrator/failure-classifier';
import { query } from '../db/client';

const DEFAULT_POLICY_PATH = join(__dirname, '../../../../config/soc-triage-policy.json');

/**
 * Fail-safe fallback: with no valid policy nothing is allowlisted or marked
 * benign, so nothing is auto-closed — every alert still gets triaged and queued.
 */
export const EMPTY_POLICY: TriagePolicy = {
  version: 'none (policy failed to load)',
  allowlist: [],
  knownBenign: [],
};

let cached: { policy: TriagePolicy; source: string; error?: string } | null = null;

export function loadTriagePolicy(
  path: string = process.env.SOC_TRIAGE_POLICY_PATH ?? DEFAULT_POLICY_PATH
): { policy: TriagePolicy; source: string; error?: string } {
  try {
    const parsed = TriagePolicySchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    if (!parsed.success) {
      const error = `invalid policy: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      console.error(`[Triage] ${error} (${path}); falling back to empty policy`);
      return { policy: EMPTY_POLICY, source: path, error };
    }
    return { policy: parsed.data, source: path };
  } catch (err) {
    const error = `could not read policy: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Triage] ${error}; falling back to empty policy`);
    return { policy: EMPTY_POLICY, source: path, error };
  }
}

export function getTriagePolicy(): { policy: TriagePolicy; source: string; error?: string } {
  cached ??= loadTriagePolicy();
  return cached;
}

export function resetTriagePolicyCache(): void {
  cached = null;
}

/**
 * Triage a newly ingested or suppressed alert and persist the decision.
 * Duplicate deliveries are not re-triaged (the original decision stands).
 */
export async function triageIngestedAlert(
  alert: SecurityAlert,
  result: AlertProcessingResult,
  enrichment: EnrichmentResponse | null,
  policy: TriagePolicy = getTriagePolicy().policy
): Promise<AlertTriage | undefined> {
  if (result.status === 'duplicate_delivery') return undefined;

  const triage = triageAlert({
    alert,
    ingestionStatus: result.status,
    enrichment,
    occurrenceCount: result.occurrenceCount,
    policy,
  });

  try {
    await query(
      `UPDATE security_alerts
       SET triage_disposition = $2, triage_priority = $3, risk_score = $4, triage = $5,
           triaged_at = NOW()
       WHERE alert_id = $1`,
      [alert.alertId, triage.disposition, triage.priority, triage.riskScore, JSON.stringify(triage)]
    );
  } catch (err) {
    console.error(
      `[Triage] failed to persist triage for ${alert.alertId}:`,
      err instanceof Error ? err.name : err
    );
  }

  return triage;
}
