import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TriagePolicy } from '@orchestrator/shared-types';
import { executeAction, guardAction, rollbackAction } from '../services/response-actions';
import { socAlert, socTriage } from './fixtures/soc-alert';

const { jira } = vi.hoisted(() => ({
  jira: { searchByLabel: vi.fn(), createIssue: vi.fn(), addComment: vi.fn() },
}));
vi.mock('../services/jira-adapter', () => jira);

const policy: TriagePolicy = {
  version: 't',
  allowlist: [
    {
      id: 'scanner-range',
      description: 'scanner',
      owner: 'o',
      expiresAt: '2099-01-01T00:00:00Z',
      match: { indicator: { type: 'ip', value: '192.0.2.0/28' } },
    },
    {
      id: 'expired',
      description: 'old',
      owner: 'o',
      expiresAt: '2000-01-01T00:00:00Z',
      match: { indicator: { type: 'ip', value: '198.51.100.7' } },
    },
  ],
  knownBenign: [],
};

describe('guardAction (blast-radius guards)', () => {
  afterEach(() => delete process.env.SOC_PROTECTED_HOSTS);

  it.each(['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '239.1.1.1'])(
    'refuses to block non-public %s',
    (ip) => {
      expect(guardAction('firewall.block_ip', ip, policy)).toMatch(/refusing/);
    }
  );

  it('refuses non-public IPv6 and non-IP targets', () => {
    expect(guardAction('firewall.block_ip', 'fd00::1', policy)).toMatch(/IPv6/);
    expect(guardAction('firewall.block_ip', 'not-an-ip', policy)).toMatch(/not an IP/);
  });

  it('refuses allowlisted IPs (CIDR) but ignores expired entries', () => {
    expect(guardAction('firewall.block_ip', '192.0.2.5', policy)).toContain('scanner-range');
    expect(guardAction('firewall.block_ip', '198.51.100.7', policy)).toBeNull();
    expect(guardAction('firewall.block_ip', '203.0.113.9', policy)).toBeNull();
  });

  it('refuses to isolate protected hosts (identity-normalized)', () => {
    process.env.SOC_PROTECTED_HOSTS = 'dc-01, dc-02';
    expect(guardAction('edr.isolate_host', 'DC-01.corp.example.com', policy)).toMatch(/protected/);
    expect(guardAction('edr.isolate_host', 'ws-042', policy)).toBeNull();
    // kill_process targets a process name; it is not an isolation and stays approvable
    expect(guardAction('edr.kill_process', 'dc-01', policy)).toBeNull();
  });
});

describe('executeAction / rollbackAction', () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { fetch: fakeFetch };
  const req = {
    alert: socAlert,
    triage: socTriage,
    fingerprint: 'a'.repeat(64),
    actor: 'human:alice',
    reason: 'test',
  };

  beforeEach(() => {
    calls.length = 0;
    process.env.SOC_ACTIONS_BASE_URL = 'http://mock:3002';
    process.env.SLACK_WEBHOOK_URL = 'http://mock:3002/slack/services/T/B/x';
    Object.values(jira).forEach((fn) => fn.mockReset());
  });

  it('blocks and unblocks an IP on the firewall', async () => {
    expect(
      await executeAction({ ...req, action: 'firewall.block_ip', targetValue: '203.0.113.9' }, deps)
    ).toBe('blocked 203.0.113.9');
    expect(await rollbackAction('firewall.block_ip', '203.0.113.9', 'human:alice', deps)).toBe(
      'unblocked 203.0.113.9'
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://mock:3002/firewall/blocks',
      'DELETE http://mock:3002/firewall/blocks/203.0.113.9',
    ]);
    expect(calls[0]!.body).toMatchObject({ ip: '203.0.113.9', requestedBy: 'human:alice' });
  });

  it('isolates/releases hosts and kills processes on the alert host via EDR', async () => {
    await executeAction({ ...req, action: 'edr.isolate_host', targetValue: 'ws-042' }, deps);
    await rollbackAction('edr.isolate_host', 'ws-042', 'human:alice', deps);
    await executeAction({ ...req, action: 'edr.kill_process', targetValue: 'invoice.exe' }, deps);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://mock:3002/edr/hosts/ws-042/isolate',
      'POST http://mock:3002/edr/hosts/ws-042/release',
      'POST http://mock:3002/edr/processes/kill',
    ]);
    expect(calls[2]!.body).toMatchObject({ host: 'ws-042', process: 'invoice.exe' });
  });

  it('refuses to roll back irreversible actions', async () => {
    await expect(rollbackAction('edr.kill_process', 'x', 'a', deps)).rejects.toThrow(
      'not reversible'
    );
  });

  it('creates a fingerprint-labelled ticket, or comments on the existing one', async () => {
    jira.searchByLabel.mockResolvedValueOnce(null);
    jira.createIssue.mockResolvedValueOnce('AUTO-7');
    expect(await executeAction({ ...req, action: 'ticket.create', targetValue: '' }, deps)).toBe(
      'created AUTO-7'
    );
    expect(jira.createIssue.mock.calls[0]![0].labels).toEqual([
      'security-alert-fingerprint-aaaaaaaaaaaa',
      'security-alert',
      'soc-p1',
    ]);

    jira.searchByLabel.mockResolvedValueOnce({
      key: 'AUTO-7',
      summary: '',
      status: '',
      labels: [],
    });
    expect(await executeAction({ ...req, action: 'ticket.create', targetValue: '' }, deps)).toBe(
      'updated AUTO-7'
    );
    expect(jira.addComment).toHaveBeenCalledOnce();
  });

  it('surfaces HTTP failures as errors', async () => {
    const failing = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(
      executeAction(
        { ...req, action: 'firewall.block_ip', targetValue: '203.0.113.9' },
        { fetch: failing }
      )
    ).rejects.toThrow('HTTP 503');
  });
});
