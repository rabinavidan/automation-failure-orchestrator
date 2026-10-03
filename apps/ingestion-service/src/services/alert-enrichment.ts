import { EnrichmentResponseSchema } from '@orchestrator/shared-types';
import type {
  AlertEnrichmentOutcome,
  AlertIngestionStatus,
  EnrichmentResponse,
  SecurityAlert,
} from '@orchestrator/shared-types';
import { query } from '../db/client';

const DEFAULT_TIMEOUT_MS = 8000;

function timeoutMs(): number {
  const raw = Number(process.env.ENRICHMENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Calls the Python enrichment service (apps/enrichment-service). Throws on
 * transport errors, non-2xx responses, and contract violations; callers decide
 * how to degrade.
 */
export async function requestEnrichment(
  baseUrl: string,
  alert: SecurityAlert,
  fetchImpl: typeof fetch = fetch
): Promise<EnrichmentResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.WEBHOOK_SECRET;

  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/enrich`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ alertId: alert.alertId, indicators: alert.indicators }),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!response.ok) throw new Error(`enrichment service returned HTTP ${response.status}`);

  const parsed = EnrichmentResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('enrichment response violated the contract');
  return parsed.data;
}

/**
 * Enriches a freshly ingested alert and persists the result. Fail-open: the
 * alert is already committed, so enrichment problems are recorded, never thrown.
 */
export async function enrichIngestedAlert(
  alert: SecurityAlert,
  status: AlertIngestionStatus,
  fetchImpl: typeof fetch = fetch
): Promise<AlertEnrichmentOutcome> {
  if (status !== 'new') return { status: 'not_applicable' };

  const baseUrl = process.env.ENRICHMENT_URL;
  if (!baseUrl) return { status: 'disabled' };

  let outcome: AlertEnrichmentOutcome;
  let enrichment: EnrichmentResponse | null = null;
  try {
    enrichment = await requestEnrichment(baseUrl, alert, fetchImpl);
    outcome = { status: 'enriched', summary: enrichment.summary };
  } catch (err) {
    const error = describeError(err);
    console.warn(`[Enrichment] ${alert.alertId}: ${error}`);
    outcome = { status: 'failed', error };
  }

  try {
    await query(
      `UPDATE security_alerts
       SET enrichment_status = $2, enrichment_verdict = $3, enrichment = $4, enriched_at = NOW()
       WHERE alert_id = $1`,
      [
        alert.alertId,
        outcome.status,
        enrichment?.summary.verdict ?? null,
        enrichment ? JSON.stringify(enrichment) : null,
      ]
    );
  } catch (err) {
    console.error(
      `[Enrichment] failed to persist result for ${alert.alertId}:`,
      describeError(err)
    );
  }

  return outcome;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    // undici reports connection failures as `TypeError: fetch failed`.
    if (err instanceof TypeError) return 'unreachable';
    // Only our own messages are surfaced; transport errors may contain URLs.
    if (err.message.startsWith('enrichment ')) return err.message;
    return err.name;
  }
  return 'unknown error';
}
