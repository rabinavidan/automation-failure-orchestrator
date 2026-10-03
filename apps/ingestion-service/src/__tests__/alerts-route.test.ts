import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AlertProcessingResult, SecurityAlert } from '@orchestrator/shared-types';
import { splunkBruteForceAlert } from './fixtures/splunk-alerts';
import { sentinelBruteForce, wazuhSshBruteForce } from './fixtures/siem-alerts';
import alertsRouter from '../routes/alerts';

const { processAlert } = vi.hoisted(() => ({
  processAlert: vi.fn<(alert: SecurityAlert) => Promise<AlertProcessingResult>>(),
}));
vi.mock('../services/alert-processor', () => ({ processAlert }));
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client', () => ({ query }));

const app = express();
app.use(express.json());
app.use('/api/alerts', alertsRouter);

function result(status: AlertProcessingResult['status']): AlertProcessingResult {
  return {
    alertId: 'a-1',
    fingerprint: 'f'.repeat(64),
    fingerprintLabel: 'security-alert-fingerprint-ffffffffffff',
    status,
    occurrenceCount: 1,
    suppressedCount: 0,
    firstSeenAt: '2025-10-03T14:00:00.000Z',
    lastSeenAt: '2025-10-03T14:00:00.000Z',
  };
}

const genericAlert = {
  schemaVersion: '1.0.0',
  alertId: 'generic-001',
  source: { vendor: 'generic' },
  ruleId: 'impossible-travel',
  ruleName: 'Impossible travel',
  title: 'Impossible travel for jdoe',
  severity: 'medium',
  detectedAt: '2025-10-03T14:00:00Z',
  user: 'jdoe',
  indicators: [{ type: 'ip', value: '203.0.113.7', role: 'source' }],
};

describe('alerts routes', () => {
  const originalSecret = process.env.WEBHOOK_SECRET;
  beforeEach(() => {
    processAlert.mockReset();
    delete process.env.WEBHOOK_SECRET;
    delete process.env.ENRICHMENT_URL;
  });
  afterEach(() => {
    if (originalSecret !== undefined) process.env.WEBHOOK_SECRET = originalSecret;
  });

  it('POST /api/alerts/splunk normalizes and returns 201 for a new alert', async () => {
    processAlert.mockResolvedValue(result('new'));
    const res = await request(app).post('/api/alerts/splunk').send(splunkBruteForceAlert);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('new');
    expect(res.body.enrichment).toEqual({ status: 'disabled' });
    // high-severity brute force, no enrichment -> analyst queue, inferred Credential Access
    expect(res.body.triage).toMatchObject({
      disposition: 'needs_investigation',
      recommendedAction: 'investigate',
      priority: 'P2',
      riskScore: 80,
    });
    const alert = processAlert.mock.calls[0]![0];
    expect(alert.source.vendor).toBe('splunk');
    expect(alert.severity).toBe('high');
    expect(alert.indicators).toContainEqual({ type: 'ip', value: '203.0.113.7', role: 'source' });
  });

  it('returns 201 for suppressed alerts (recorded) and 200 for duplicate deliveries', async () => {
    processAlert.mockResolvedValueOnce(result('suppressed'));
    expect((await request(app).post('/api/alerts/splunk').send(splunkBruteForceAlert)).status).toBe(
      201
    );

    processAlert.mockResolvedValueOnce(result('duplicate_delivery'));
    const dup = await request(app).post('/api/alerts/splunk').send(splunkBruteForceAlert);
    expect(dup.status).toBe(200);
    expect(dup.body.status).toBe('duplicate_delivery');
    expect(dup.body.triage).toBeUndefined();
  });

  it('routes Sentinel and Wazuh payloads through their normalizers', async () => {
    processAlert.mockResolvedValue(result('new'));
    const sentinel = await request(app).post('/api/alerts/sentinel').send(sentinelBruteForce);
    expect(sentinel.status).toBe(201);
    expect(processAlert.mock.calls.at(-1)![0].source.vendor).toBe('sentinel');

    const wazuh = await request(app).post('/api/alerts/wazuh').send(wazuhSshBruteForce);
    expect(wazuh.status).toBe(201);
    expect(processAlert.mock.calls.at(-1)![0].ruleId).toBe('wazuh-rule-5712');
  });

  it('returns 404 for unknown SIEM vendors and 400 for invalid vendor payloads', async () => {
    const unknown = await request(app).post('/api/alerts/qradar').send({});
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain('splunk, sentinel, wazuh');
    expect(
      (await request(app).post('/api/alerts/sentinel').send({ Severity: 'High' })).status
    ).toBe(400);
    expect(processAlert).not.toHaveBeenCalled();
  });

  it('rejects a malformed Splunk payload with 400', async () => {
    const res = await request(app).post('/api/alerts/splunk').send({ search_name: 'x' });
    expect(res.status).toBe(400);
    expect(processAlert).not.toHaveBeenCalled();
  });

  it('POST /api/alerts accepts the normalized contract directly', async () => {
    processAlert.mockResolvedValue(result('new'));
    const res = await request(app).post('/api/alerts').send(genericAlert);
    expect(res.status).toBe(201);
    expect(processAlert.mock.calls[0]![0].alertId).toBe('generic-001');
  });

  it('rejects invalid MITRE technique IDs in the normalized contract', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .send({ ...genericAlert, mitre: { tactics: [], techniques: ['bogus'] } });
    expect(res.status).toBe(400);
  });

  it('enforces the webhook secret when configured', async () => {
    process.env.WEBHOOK_SECRET = 'soc-secret';
    const res = await request(app).post('/api/alerts/splunk').send(splunkBruteForceAlert);
    expect(res.status).toBe(401);
  });

  it('returns 500 without leaking internals when processing fails', async () => {
    processAlert.mockRejectedValue(new Error('db down: password=hunter2'));
    const res = await request(app).post('/api/alerts').send(genericAlert);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('rejects unknown status, disposition and priority filters on GET /api/alerts', async () => {
    for (const q of ['status=bogus', 'disposition=bogus', 'priority=P9']) {
      expect((await request(app).get(`/api/alerts?${q}`)).status).toBe(400);
    }
  });

  it('computes SOC metrics including automation rate and clamps the window', async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce([{ total: 10, auto_closed: 7, true_positives: 2, analyst_queue: 1 }])
      .mockResolvedValueOnce([{ disposition: 'false_positive', count: 5 }])
      .mockResolvedValueOnce([{ priority: 'P1', count: 2 }])
      .mockResolvedValueOnce([{ technique: 'T1110', count: 4 }])
      .mockResolvedValueOnce([{ pending_approval: 1, contained: 1 }]);
    const res = await request(app).get('/api/alerts/metrics?hours=99999');
    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(720);
    expect(res.body.alerts.automationRate).toBe(0.7);
    expect(res.body.topTechniques[0]).toEqual({ technique: 'T1110', count: 4 });
    expect(query.mock.calls[0]![1]).toEqual([720]);
  });

  it('reports a zero automation rate when there are no alerts', async () => {
    query.mockReset();
    query.mockResolvedValueOnce([{ total: 0, auto_closed: 0 }]).mockResolvedValue([]);
    const res = await request(app).get('/api/alerts/metrics');
    expect(res.body.alerts.automationRate).toBe(0);
    expect(res.body.windowHours).toBe(24);
  });

  it('exposes the active triage policy', async () => {
    const res = await request(app).get('/api/alerts/triage-policy');
    expect(res.status).toBe(200);
    expect(res.body.version).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    expect(res.body.allowlist.length).toBeGreaterThan(0);
    expect(res.body.error).toBeUndefined();
  });
});
