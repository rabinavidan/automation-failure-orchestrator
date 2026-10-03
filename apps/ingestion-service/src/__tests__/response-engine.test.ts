import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Playbook, TriagePolicy } from '@orchestrator/shared-types';
import {
  decideResponseAction,
  resolveTargets,
  rollbackResponseAction,
  runResponsePlaybooks,
} from '../services/response-engine';
import { socAlert, socTriage } from './fixtures/soc-alert';

const { query, jira } = vi.hoisted(() => ({
  query: vi.fn(),
  jira: { searchByLabel: vi.fn(), createIssue: vi.fn(), addComment: vi.fn() },
}));
vi.mock('../db/client', () => ({ query }));
vi.mock('../services/jira-adapter', () => jira);

const policy: TriagePolicy = { version: 't', allowlist: [], knownBenign: [] };
const playbook: Playbook = {
  id: 'brute-force-response',
  version: 1,
  description: 'd',
  owner: 'o',
  trigger: { dispositions: ['true_positive'], techniques: ['T1110'] },
  steps: [
    { id: 'open-case', action: 'ticket.create', description: 'ticket', approval: 'none' },
    {
      id: 'block-source-ip',
      action: 'firewall.block_ip',
      description: 'block',
      target: { indicator: 'ip', role: 'source' },
      approval: 'required',
    },
  ],
};

const fakeFetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
const deps = { fetch: fakeFetch };

/** Routes SQL to an in-memory response_actions table. */
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const events: Array<{ id: string; event: string; actor: string }> = [];
  let nextId = 0;
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO response_actions')) {
      const key = `${params[1]}/${params[3]}/${params[7]}`;
      if ([...rows.values()].some((r) => r.key === key)) return [];
      const id = String(++nextId);
      rows.set(id, {
        id,
        key,
        alert_id: params[0],
        action: params[4],
        description: params[5],
        target_value: params[7],
        status: params[9],
      });
      return [{ id }];
    }
    if (sql.includes('INSERT INTO response_action_events')) {
      events.push({ id: String(params[0]), event: String(params[1]), actor: String(params[2]) });
      return [];
    }
    if (sql.includes("WHERE id = $1 AND status = 'pending_approval'")) {
      const row = rows.get(String(params[0]));
      if (!row || row.status !== 'pending_approval') return [];
      row.status = params[1];
      return [{ ...row }];
    }
    if (sql.includes("status = 'rolled_back'") && sql.includes("status = 'succeeded' RETURNING")) {
      const row = rows.get(String(params[0]));
      if (!row || row.status !== 'succeeded') return [];
      row.status = 'rolled_back';
      return [{ ...row }];
    }
    if (sql.startsWith('UPDATE response_actions SET status = $2, detail = $3')) {
      const row = rows.get(String(params[0]))!;
      row.status = params[1];
      row.detail = params[2];
      return [];
    }
    if (sql.includes('SELECT * FROM response_actions WHERE id')) {
      const row = rows.get(String(params[0]));
      return row ? [{ ...row }] : [];
    }
    if (sql.includes('SELECT alert, triage, fingerprint FROM security_alerts')) {
      return [{ alert: socAlert, triage: socTriage, fingerprint: 'f'.repeat(64) }];
    }
    return [];
  });
  return { rows, events };
}

const ctx = { alert: socAlert, triage: socTriage, fingerprint: 'f'.repeat(64) };

describe('resolveTargets', () => {
  it('picks indicators by type and role; steps without targets run once', () => {
    expect(resolveTargets(playbook.steps[1]!, socAlert)).toEqual(['203.0.113.9']);
    expect(resolveTargets(playbook.steps[0]!, socAlert)).toEqual(['']);
    expect(
      resolveTargets(
        { ...playbook.steps[1]!, target: { indicator: 'ip', role: 'destination' } },
        socAlert
      )
    ).toEqual([]);
  });
});

describe('runResponsePlaybooks', () => {
  beforeEach(() => {
    query.mockReset();
    Object.values(jira).forEach((fn) => fn.mockReset());
    jira.searchByLabel.mockResolvedValue(null);
    jira.createIssue.mockResolvedValue('AUTO-1');
  });

  it('runs low-risk steps now and queues containment for approval', async () => {
    const { events } = fakeDb();
    const outcome = await runResponsePlaybooks(ctx, deps, [playbook], policy);
    expect(outcome.playbooks).toEqual(['brute-force-response']);
    expect(outcome.actions.map((a) => [a.stepId, a.status])).toEqual([
      ['open-case', 'succeeded'],
      ['block-source-ip', 'pending_approval'],
    ]);
    expect(events.map((e) => e.event)).toEqual(['planned', 'executed', 'planned']);
    expect(fakeFetch).not.toHaveBeenCalled(); // nothing touched the firewall yet
  });

  it('is idempotent across webhook re-deliveries', async () => {
    fakeDb();
    await runResponsePlaybooks(ctx, deps, [playbook], policy);
    const again = await runResponsePlaybooks(ctx, deps, [playbook], policy);
    expect(again.actions).toEqual([]);
    expect(jira.createIssue).toHaveBeenCalledOnce();
  });

  it('records guard-blocked containment without ever requesting approval', async () => {
    fakeDb();
    const alert = {
      ...socAlert,
      indicators: [{ type: 'ip' as const, value: '10.0.0.5', role: 'source' as const }],
    };
    const outcome = await runResponsePlaybooks({ ...ctx, alert }, deps, [playbook], policy);
    expect(outcome.actions[1]).toMatchObject({
      status: 'blocked_by_guard',
      detail: expect.stringMatching(/private/),
    });
  });
});

describe('decideResponseAction / rollbackResponseAction', () => {
  beforeEach(() => {
    query.mockReset();
    (fakeFetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    jira.searchByLabel.mockResolvedValue(null);
    jira.createIssue.mockResolvedValue('AUTO-1');
  });

  it('executes on approval, then allows exactly one rollback', async () => {
    const { events } = fakeDb();
    const { actions } = await runResponsePlaybooks(ctx, deps, [playbook], policy);
    const id = actions[1]!.id;

    const approved = await decideResponseAction(
      { id, decision: 'approved', reviewer: 'alice' },
      deps,
      policy
    );
    expect(approved).toEqual({ ok: true, status: 'succeeded', detail: 'blocked 203.0.113.9' });

    const second = await decideResponseAction(
      { id, decision: 'approved', reviewer: 'bob' },
      deps,
      policy
    );
    expect(second).toMatchObject({ ok: false, code: 409 });

    expect(
      await rollbackResponseAction({ id, reviewer: 'alice', reason: 'false alarm' }, deps)
    ).toEqual({
      ok: true,
      status: 'rolled_back',
      detail: 'unblocked 203.0.113.9',
    });
    expect(
      await rollbackResponseAction({ id, reviewer: 'alice', reason: 'again' }, deps)
    ).toMatchObject({ ok: false, code: 409 });
    expect(events.filter((e) => e.id === id).map((e) => `${e.event}:${e.actor}`)).toEqual([
      'planned:system:playbook-engine',
      'approved:human:alice',
      'executed:human:alice',
      'rolled_back:human:alice',
    ]);
  });

  it('re-checks guards at execution time', async () => {
    fakeDb();
    const { actions } = await runResponsePlaybooks(ctx, deps, [playbook], policy);
    const tightened: TriagePolicy = {
      ...policy,
      allowlist: [
        {
          id: 'partner-range',
          description: 'partner',
          owner: 'o',
          expiresAt: '2099-01-01T00:00:00Z',
          match: { indicator: { type: 'ip', value: '203.0.113.0/24' } },
        },
      ],
    };
    const outcome = await decideResponseAction(
      { id: actions[1]!.id, decision: 'approved', reviewer: 'alice' },
      deps,
      tightened
    );
    expect(outcome).toMatchObject({ ok: true, status: 'blocked_by_guard' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('rejection never executes', async () => {
    fakeDb();
    const { actions } = await runResponsePlaybooks(ctx, deps, [playbook], policy);
    expect(
      await decideResponseAction(
        { id: actions[1]!.id, decision: 'rejected', reviewer: 'alice', comment: 'partner IP' },
        deps,
        policy
      )
    ).toEqual({ ok: true, status: 'rejected' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown actions', async () => {
    fakeDb();
    expect(
      await decideResponseAction({ id: '999', decision: 'approved', reviewer: 'a' }, deps, policy)
    ).toMatchObject({ ok: false, code: 404 });
  });
});
