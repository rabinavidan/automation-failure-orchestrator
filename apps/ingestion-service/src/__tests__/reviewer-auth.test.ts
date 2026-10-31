import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app';
import { parseReviewerTokens } from '../middleware/reviewer-auth';

// vi.mock is hoisted above the imports; vi.hoisted makes the spies available to it.
const { decideResponseAction, rollbackResponseAction } = vi.hoisted(() => ({
  decideResponseAction: vi.fn(async (input: { reviewer: string }) => ({
    ok: true as const,
    status: 'succeeded',
    reviewer: input.reviewer,
  })),
  rollbackResponseAction: vi.fn(async (input: { reviewer: string }) => ({
    ok: true as const,
    status: 'rolled_back',
    reviewer: input.reviewer,
  })),
}));
vi.mock('../services/response-engine', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decideResponseAction,
  rollbackResponseAction,
}));

const SOC = 'soc-token-0123456789abcdef';
const CI = 'ci-token-0123456789abcdefgh';
const ADMIN = 'admin-token-0123456789abcd';

const protectedRoutes = [
  '/api/approvals/run-1%3Afp/decision',
  '/api/responses/actions/1/decision',
  '/api/responses/actions/1/rollback',
  `/api/failures/${'a'.repeat(64)}/reclassify`,
  '/api/knowledge/reindex',
];

beforeEach(() => {
  process.env.REVIEWER_TOKENS = `alice:soc_responder:${SOC};bob:ci_reviewer:${CI};root:admin:${ADMIN}`;
});
afterEach(() => {
  delete process.env.REVIEWER_TOKENS;
  vi.clearAllMocks();
});

describe('REVIEWER_TOKENS parsing', () => {
  it('accepts valid entries and rejects bad roles, names and short tokens', () => {
    const { identities, errors } = parseReviewerTokens(
      `alice:soc_responder+ci_reviewer:${SOC};eve:superuser:${CI};bad name:admin:${ADMIN};carol:admin:short`
    );
    expect(identities.map((i) => [i.name, i.roles])).toEqual([
      ['alice', ['soc_responder', 'ci_reviewer']],
    ]);
    expect(errors).toHaveLength(3);
  });
});

describe('approval endpoints require an authenticated reviewer', () => {
  it('fail closed when no identities are configured', async () => {
    delete process.env.REVIEWER_TOKENS;
    for (const path of protectedRoutes) {
      const res = await request(app).post(path).set('authorization', `Bearer ${SOC}`).send({});
      expect(res.status, path).toBe(503);
    }
  });

  it('reject anonymous and unknown tokens on every protected route', async () => {
    for (const path of protectedRoutes) {
      expect((await request(app).post(path).send({ reviewer: 'mallory' })).status, path).toBe(401);
      expect(
        (await request(app).post(path).set('authorization', 'Bearer not-a-real-token-000').send({}))
          .status,
        path
      ).toBe(401);
    }
    expect(decideResponseAction).not.toHaveBeenCalled();
  });

  it('enforce roles: a CI reviewer cannot approve containment, a SOC responder cannot approve CI', async () => {
    const soc = await request(app)
      .post('/api/responses/actions/1/decision')
      .set('authorization', `Bearer ${CI}`)
      .send({ decision: 'approved' });
    expect(soc.status).toBe(403);
    const ci = await request(app)
      .post('/api/approvals/run-1%3Afp/decision')
      .set('authorization', `Bearer ${SOC}`)
      .send({ decision: 'approved' });
    expect(ci.status).toBe(403);
    const reindex = await request(app)
      .post('/api/knowledge/reindex')
      .set('authorization', `Bearer ${CI}`);
    expect(reindex.status).toBe(403);
    expect(decideResponseAction).not.toHaveBeenCalled();
  });

  it('records the authenticated identity, not the reviewer named in the body', async () => {
    const res = await request(app)
      .post('/api/responses/actions/7/decision')
      .set('authorization', `Bearer ${SOC}`)
      .send({ decision: 'approved', reviewer: 'someone-else' });
    expect(res.status).toBe(200);
    expect(decideResponseAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: '7', reviewer: 'alice' })
    );
    const admin = await request(app)
      .post('/api/responses/actions/7/rollback')
      .set('authorization', `Bearer ${ADMIN}`)
      .send({ reviewer: 'alice', reason: 'admin override' });
    expect(admin.status).toBe(200);
    expect(rollbackResponseAction).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: 'root' })
    );
  });

  it('whoami returns the identity for a valid token only', async () => {
    const ok = await request(app).get('/api/auth/whoami').set('authorization', `Bearer ${CI}`);
    expect(ok.body).toEqual({ name: 'bob', roles: ['ci_reviewer'] });
    expect((await request(app).get('/api/auth/whoami')).status).toBe(401);
  });
});
