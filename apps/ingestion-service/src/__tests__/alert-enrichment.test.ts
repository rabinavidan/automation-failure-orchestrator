import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EnrichmentResponseSchema, SecurityAlertSchema } from '@orchestrator/shared-types';
import type { SecurityAlert } from '@orchestrator/shared-types';
import { enrichIngestedAlert, requestEnrichment } from '../services/alert-enrichment';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client', () => ({ query }));

const CONTRACT_DIR = join(__dirname, '../../../enrichment-service/contract');
const goldenResponse = JSON.parse(
  readFileSync(join(CONTRACT_DIR, 'enrich-response.example.json'), 'utf-8')
);
const goldenRequest = JSON.parse(
  readFileSync(join(CONTRACT_DIR, 'enrich-request.example.json'), 'utf-8')
);

const alert: SecurityAlert = {
  schemaVersion: '1.0.0',
  alertId: goldenRequest.alertId,
  source: { vendor: 'splunk' },
  ruleId: 'brute-force',
  ruleName: 'Brute force',
  title: 'Brute force',
  severity: 'high',
  detectedAt: '2025-10-03T14:00:00Z',
  indicators: goldenRequest.indicators,
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  ) as unknown as typeof fetch;
}

describe('enrichment contract (shared with apps/enrichment-service)', () => {
  it('accepts the golden Python mock-mode response', () => {
    const parsed = EnrichmentResponseSchema.safeParse(goldenResponse);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.summary.verdict).toBe('malicious');
  });

  it('golden request indicators conform to the SecurityAlert contract', () => {
    expect(SecurityAlertSchema.shape.indicators.safeParse(goldenRequest.indicators).success).toBe(
      true
    );
  });
});

describe('requestEnrichment', () => {
  const originalSecret = process.env.WEBHOOK_SECRET;
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = originalSecret;
  });

  it('posts alertId + indicators with the shared secret', async () => {
    process.env.WEBHOOK_SECRET = 'shared';
    const fetchImpl = fakeFetch(200, goldenResponse);
    await requestEnrichment('http://enrichment:3003/', alert, fetchImpl);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://enrichment:3003/enrich');
    expect(init.headers['x-webhook-secret']).toBe('shared');
    expect(JSON.parse(init.body)).toEqual({
      alertId: alert.alertId,
      indicators: alert.indicators,
    });
  });

  it('rejects responses that violate the contract', async () => {
    await expect(
      requestEnrichment('http://e', alert, fakeFetch(200, { summary: 'nope' }))
    ).rejects.toThrow('enrichment response violated the contract');
  });
});

describe('enrichIngestedAlert', () => {
  const originalUrl = process.env.ENRICHMENT_URL;
  beforeEach(() => {
    query.mockReset();
    process.env.ENRICHMENT_URL = 'http://enrichment:3003';
  });
  afterEach(() => {
    if (originalUrl === undefined) delete process.env.ENRICHMENT_URL;
    else process.env.ENRICHMENT_URL = originalUrl;
  });

  it('enriches new alerts and persists the verdict', async () => {
    const outcome = await enrichIngestedAlert(alert, 'new', fakeFetch(200, goldenResponse));
    expect(outcome).toEqual({ status: 'enriched', summary: goldenResponse.summary });
    const [, params] = query.mock.calls[0]!;
    expect(params.slice(0, 3)).toEqual([alert.alertId, 'enriched', 'malicious']);
  });

  it.each(['suppressed', 'duplicate_delivery'] as const)(
    'never spends threat-intel quota on %s alerts',
    async (status) => {
      const fetchImpl = fakeFetch(200, goldenResponse);
      expect(await enrichIngestedAlert(alert, status, fetchImpl)).toEqual({
        status: 'not_applicable',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  );

  it('is disabled when ENRICHMENT_URL is unset', async () => {
    delete process.env.ENRICHMENT_URL;
    expect(await enrichIngestedAlert(alert, 'new', fakeFetch(200, goldenResponse))).toEqual({
      status: 'disabled',
    });
  });

  it('fails open on HTTP errors and records the failure', async () => {
    const outcome = await enrichIngestedAlert(alert, 'new', fakeFetch(503, {}));
    expect(outcome).toEqual({ status: 'failed', error: 'enrichment service returned HTTP 503' });
    expect(query.mock.calls[0]![1].slice(0, 4)).toEqual([alert.alertId, 'failed', null, null]);
  });

  it('fails open on transport errors without leaking details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED http://user:pw@enrichment');
    }) as unknown as typeof fetch;
    const outcome = await enrichIngestedAlert(alert, 'new', fetchImpl);
    expect(outcome).toEqual({ status: 'failed', error: 'unreachable' });
  });

  it('still returns an outcome when persisting fails', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const outcome = await enrichIngestedAlert(alert, 'new', fakeFetch(200, goldenResponse));
    expect(outcome.status).toBe('enriched');
  });
});
