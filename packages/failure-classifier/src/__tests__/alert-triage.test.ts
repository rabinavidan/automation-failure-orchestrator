import { describe, it, expect } from 'vitest';
import { TriagePolicySchema } from '@orchestrator/shared-types';
import type {
  EnrichmentResponse,
  SecurityAlert,
  TriageInput,
  TriagePolicy,
} from '@orchestrator/shared-types';
import { triageAlert, riskScore, priorityFor } from '../alert-triage/triage';
import { resolveMitre } from '../alert-triage/mitre';
import { ipMatches, wildcardMatch, entryMatches } from '../alert-triage/policy-match';

const now = new Date('2026-10-03T12:00:00Z');
const future = '2027-01-01T00:00:00Z';
const past = '2026-01-01T00:00:00Z';

const policy: TriagePolicy = TriagePolicySchema.parse({
  version: 'test-1',
  allowlist: [
    {
      id: 'vuln-scanner',
      description: 'Internal Nessus scanner',
      owner: 'secops',
      expiresAt: future,
      match: { indicator: { type: 'ip', value: '192.0.2.0/28' } },
    },
    {
      id: 'expired-pentest',
      description: 'Q1 pentest range',
      owner: 'secops',
      expiresAt: past,
      match: { indicator: { type: 'ip', value: '198.51.100.0/24' } },
    },
  ],
  knownBenign: [
    {
      id: 'synthetic-login-monitor',
      description: 'Synthetic monitor generates failed logins',
      owner: 'sre',
      expiresAt: future,
      match: { ruleId: '*Brute Force*', user: 'svc_healthcheck' },
    },
  ],
});

function alert(overrides: Partial<SecurityAlert> = {}): SecurityAlert {
  return {
    schemaVersion: '1.0.0',
    alertId: 'a-1',
    source: { vendor: 'splunk' },
    ruleId: 'Access - Brute Force Access Behavior Detected - Rule',
    ruleName: 'Access - Brute Force Access Behavior Detected - Rule',
    title: 'Brute Force Access Behavior Detected',
    severity: 'medium',
    detectedAt: now.toISOString(),
    host: 'ws-042',
    user: 'CORP\\jdoe',
    indicators: [{ type: 'ip', value: '8.8.8.8', role: 'source' }],
    ...overrides,
  };
}

function enrichment(verdict: 'malicious' | 'suspicious' | 'benign', value = '8.8.8.8') {
  return {
    mode: 'mock',
    summary: {
      verdict,
      maxScore: verdict === 'malicious' ? 100 : 0,
      malicious: verdict === 'malicious' ? 1 : 0,
      suspicious: verdict === 'suspicious' ? 1 : 0,
      enriched: 1,
      skipped: 0,
      providerErrors: 0,
    },
    enrichments: [
      {
        indicator: { type: 'ip', value, role: 'source' },
        normalizedValue: value,
        verdict,
        score: verdict === 'malicious' ? 100 : 0,
        results: [
          { provider: 'abuseipdb', verdict, score: 100, summary: '', details: {}, cached: false },
        ],
      },
    ],
  } as EnrichmentResponse;
}

function input(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    alert: alert(),
    ingestionStatus: 'new',
    enrichment: enrichment('benign'),
    occurrenceCount: 1,
    policy,
    now,
    ...overrides,
  };
}

describe('triageAlert priority chain', () => {
  it('1. allowlisted indicator -> false_positive, closed, even if intel says malicious', () => {
    const result = triageAlert(
      input({
        alert: alert({ indicators: [{ type: 'ip', value: '192.0.2.5', role: 'source' }] }),
        enrichment: enrichment('malicious', '192.0.2.5'),
      })
    );
    expect(result).toMatchObject({
      disposition: 'false_positive',
      recommendedAction: 'close',
      matchedPolicyId: 'vuln-scanner',
      riskScore: 0,
      priority: 'P4',
      policyVersion: 'test-1',
    });
  });

  it('expired allowlist entries stop matching', () => {
    const result = triageAlert(
      input({ alert: alert({ indicators: [{ type: 'ip', value: '198.51.100.9' }] }) })
    );
    expect(result.disposition).not.toBe('false_positive');
  });

  it('2. suppressed repeat -> duplicate, suppress', () => {
    const result = triageAlert(input({ ingestionStatus: 'suppressed', occurrenceCount: 4 }));
    expect(result.disposition).toBe('duplicate');
    expect(result.recommendedAction).toBe('suppress');
    expect(result.reasons[0]).toContain('4 occurrences');
  });

  it('3a. malicious threat intel -> true_positive with the evidence named', () => {
    const result = triageAlert(input({ enrichment: enrichment('malicious') }));
    expect(result.disposition).toBe('true_positive');
    expect(result.recommendedAction).toBe('escalate');
    expect(result.reasons[0]).toBe('Threat intel: ip 8.8.8.8 (abuseipdb 100) is malicious');
  });

  it('3b. critical high-confidence technique -> true_positive without intel', () => {
    const result = triageAlert(
      input({
        alert: alert({
          ruleName: 'Endpoint - LSASS Memory Access',
          ruleId: 'lsass-access',
          severity: 'critical',
          mitre: { tactics: [], techniques: ['T1003.001'] },
        }),
        enrichment: null,
      })
    );
    expect(result.disposition).toBe('true_positive');
    expect(result.priority).toBe('P1');
  });

  it('true positives are never ranked below P2', () => {
    const result = triageAlert(
      input({ alert: alert({ severity: 'low' }), enrichment: enrichment('malicious') })
    );
    expect(result.riskScore).toBeLessThan(65);
    expect(result.priority).toBe('P2');
  });

  it('4. known-benign policy -> benign_true_positive', () => {
    const result = triageAlert(
      input({ alert: alert({ user: 'svc_healthcheck@corp.example.com' }) })
    );
    expect(result).toMatchObject({
      disposition: 'benign_true_positive',
      recommendedAction: 'close',
      matchedPolicyId: 'synthetic-login-monitor',
    });
  });

  it('malicious intel outranks known-benign policy', () => {
    const result = triageAlert(
      input({ alert: alert({ user: 'svc_healthcheck' }), enrichment: enrichment('malicious') })
    );
    expect(result.disposition).toBe('true_positive');
  });

  it('5. everything else -> needs_investigation ranked by risk', () => {
    const result = triageAlert(input({ alert: alert({ severity: 'high' }) }));
    expect(result.disposition).toBe('needs_investigation');
    expect(result.recommendedAction).toBe('investigate');
    // high (70) + Credential Access late-stage tactic (10) = 80
    expect(result.riskScore).toBe(80);
    expect(result.priority).toBe('P2');
  });

  it('flags missing enrichment in the evidence trail', () => {
    const result = triageAlert(input({ enrichment: null }));
    expect(result.reasons).toContain(
      'Threat-intel enrichment unavailable; verdict based on detection only'
    );
  });
});

describe('riskScore / priorityFor', () => {
  it('adds intel, kill-chain and recurrence factors and caps at 100', () => {
    const { score, factors } = riskScore({
      severity: 'critical',
      enrichmentVerdict: 'malicious',
      tactics: ['Impact'],
      occurrenceCount: 25,
    });
    expect(score).toBe(100);
    expect(factors).toHaveLength(4);
  });

  it('maps scores to priorities', () => {
    expect([90, 70, 45, 10].map(priorityFor)).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
});

describe('resolveMitre', () => {
  it('keeps SIEM techniques and derives tactics', () => {
    expect(resolveMitre(alert({ mitre: { tactics: [], techniques: ['T1110.001'] } }))).toEqual({
      tactics: ['Credential Access'],
      techniques: ['T1110.001'],
      inferred: false,
    });
  });

  it('infers a technique from the rule name when none is supplied', () => {
    const result = resolveMitre(alert({ ruleName: 'Ransomware file encryption burst' }));
    expect(result).toEqual({ tactics: ['Impact'], techniques: ['T1486'], inferred: true });
  });

  it('returns empty when nothing can be inferred', () => {
    expect(resolveMitre(alert({ ruleName: 'Odd thing', title: 'Odd' })).techniques).toEqual([]);
  });
});

describe('policy matching', () => {
  it('matches IPv4 CIDRs and exact addresses', () => {
    expect(ipMatches('10.0.0.0/8', '10.20.30.40')).toBe(true);
    expect(ipMatches('10.0.0.0/8', '11.0.0.1')).toBe(false);
    expect(ipMatches('192.0.2.0/28', '192.0.2.15')).toBe(true);
    expect(ipMatches('192.0.2.0/28', '192.0.2.16')).toBe(false);
    expect(ipMatches('0.0.0.0/0', '8.8.8.8')).toBe(true);
    expect(ipMatches('2001:db8::1', '2001:DB8::1')).toBe(true);
    expect(ipMatches('10.0.0.0/33', '10.0.0.1')).toBe(false);
  });

  it('supports * wildcards and escapes regex metacharacters', () => {
    expect(wildcardMatch('*Brute Force*', 'Access - Brute Force - Rule')).toBe(true);
    expect(wildcardMatch('a.b', 'aXb')).toBe(false);
  });

  it('ANDs criteria: rule match alone is not enough when user differs', () => {
    const entry = policy.knownBenign[0]!;
    expect(entryMatches(entry, alert({ user: 'jdoe' }), now)).toBe(false);
    expect(entryMatches(entry, alert({ user: 'CORP\\svc_healthcheck' }), now)).toBe(true);
  });
});

describe('TriagePolicySchema', () => {
  it('rejects entries with no match criteria or no expiry', () => {
    const base = { version: 'v', knownBenign: [] };
    const noCriteria = {
      ...base,
      allowlist: [{ id: 'x', description: 'd', owner: 'o', expiresAt: future, match: {} }],
    };
    const noExpiry = {
      ...base,
      allowlist: [{ id: 'x', description: 'd', owner: 'o', match: { user: 'u' } }],
    };
    expect(TriagePolicySchema.safeParse(noCriteria).success).toBe(false);
    expect(TriagePolicySchema.safeParse(noExpiry).success).toBe(false);
  });
});
