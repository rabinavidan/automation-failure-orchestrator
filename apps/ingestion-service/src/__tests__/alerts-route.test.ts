import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AlertProcessingResult, SecurityAlert } from '@orchestrator/shared-types';
import { splunkBruteForceAlert } from './fixtures/splunk-alerts';
import alertsRouter from '../routes/alerts';

const { processAlert } = vi.hoisted(() => ({
  processAlert: vi.fn<(alert: SecurityAlert) => Promise<AlertProcessingResult>>(),
}));
vi.mock('../services/alert-processor', () => ({ processAlert }));
vi.mock('../db/client', () => ({ query: vi.fn() }));

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
  });
  afterEach(() => {
    if (originalSecret !== undefined) process.env.WEBHOOK_SECRET = originalSecret;
  });

  it('POST /api/alerts/splunk normalizes and returns 201 for a new alert', async () => {
    processAlert.mockResolvedValue(result('new'));
    const res = await request(app).post('/api/alerts/splunk').send(splunkBruteForceAlert);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('new');
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

  it('rejects unknown status filters on GET /api/alerts', async () => {
    const res = await request(app).get('/api/alerts?status=bogus');
    expect(res.status).toBe(400);
  });
});
