import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AlertProcessingResult,
  SecurityAlert,
  TriagePolicy,
} from '@orchestrator/shared-types';
import { EMPTY_POLICY, loadTriagePolicy, triageIngestedAlert } from '../services/alert-triage';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client', () => ({ query }));

const alert: SecurityAlert = {
  schemaVersion: '1.0.0',
  alertId: 'a-1',
  source: { vendor: 'splunk' },
  ruleId: 'scan',
  ruleName: 'Network scan detected',
  title: 'Network scan detected',
  severity: 'medium',
  detectedAt: '2026-10-03T12:00:00Z',
  indicators: [{ type: 'ip', value: '192.0.2.10', role: 'source' }],
};

function result(status: AlertProcessingResult['status']): AlertProcessingResult {
  return {
    alertId: 'a-1',
    fingerprint: 'f'.repeat(64),
    fingerprintLabel: 'l',
    status,
    occurrenceCount: 1,
    suppressedCount: 0,
    firstSeenAt: '',
    lastSeenAt: '',
  };
}

// Fixed far-future expiry so the test does not depend on the checked-in policy's dates.
const scannerPolicy: TriagePolicy = {
  version: 'test',
  allowlist: [
    {
      id: 'internal-vuln-scanner',
      description: 'scanner',
      owner: 'secops',
      expiresAt: '2099-01-01T00:00:00Z',
      match: { indicator: { type: 'ip', value: '192.0.2.10' } },
    },
  ],
  knownBenign: [],
};

function writePolicy(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  const path = join(dir, 'policy.json');
  writeFileSync(path, content);
  return path;
}

describe('loadTriagePolicy', () => {
  it('loads and validates the checked-in policy', () => {
    const { policy, error } = loadTriagePolicy();
    expect(error).toBeUndefined();
    expect(policy.allowlist.map((e) => e.id)).toContain('internal-vuln-scanner');
  });

  it('falls back to the empty (nothing auto-closed) policy on invalid content', () => {
    const { policy, error } = loadTriagePolicy(
      writePolicy(JSON.stringify({ version: 'x', allowlist: [{ id: 'BAD ID' }] }))
    );
    expect(policy).toEqual(EMPTY_POLICY);
    expect(error).toMatch(/^invalid policy: allowlist\.0/);
  });

  it('falls back on unreadable or malformed files', () => {
    expect(loadTriagePolicy('/nonexistent/policy.json').policy).toEqual(EMPTY_POLICY);
    expect(loadTriagePolicy(writePolicy('{not json')).policy).toEqual(EMPTY_POLICY);
  });
});

describe('triageIngestedAlert', () => {
  beforeEach(() => query.mockReset());

  it('triages with the given policy and persists the decision', async () => {
    const triage = await triageIngestedAlert(alert, result('new'), null, scannerPolicy);
    expect(triage).toMatchObject({
      disposition: 'false_positive',
      matchedPolicyId: 'internal-vuln-scanner',
    });
    const [, params] = query.mock.calls[0]!;
    expect(params.slice(0, 4)).toEqual(['a-1', 'false_positive', 'P4', 0]);
  });

  it('does not re-triage duplicate deliveries', async () => {
    expect(await triageIngestedAlert(alert, result('duplicate_delivery'), null)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('with the empty fallback policy nothing is auto-closed', async () => {
    const triage = await triageIngestedAlert(alert, result('new'), null, EMPTY_POLICY);
    expect(triage?.disposition).toBe('needs_investigation');
  });

  it('returns the decision even if persisting fails', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    expect(
      (await triageIngestedAlert(alert, result('new'), null, scannerPolicy))?.disposition
    ).toBe('false_positive');
  });
});
