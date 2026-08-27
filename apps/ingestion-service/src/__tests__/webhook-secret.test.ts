import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhookSecret } from '../middleware/webhook-secret';

// Mock supertest
const app = express();
app.use(express.json());
app.use('/test', webhookSecret, (_req, res) => res.json({ ok: true }));

describe('webhookSecret middleware', () => {
  const originalSecret = process.env.WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-secret-123';
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.WEBHOOK_SECRET;
    } else {
      process.env.WEBHOOK_SECRET = originalSecret;
    }
  });

  it('allows request with correct secret', async () => {
    const res = await request(app).get('/test').set('x-webhook-secret', 'test-secret-123');
    expect(res.status).toBe(200);
  });

  it('rejects request with wrong secret', async () => {
    const res = await request(app).get('/test').set('x-webhook-secret', 'wrong-secret');
    expect(res.status).toBe(403);
  });

  it('rejects request with no secret header', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
  });

  it('allows all requests when WEBHOOK_SECRET is not set', async () => {
    delete process.env.WEBHOOK_SECRET;
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });
});
