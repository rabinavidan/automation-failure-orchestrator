import { describe, it, expect } from 'vitest';
import type { SocInvestigation } from '@orchestrator/shared-types';
import { evaluateSocInvestigation, extractIndicators } from '../services/soc-agent-evaluation';
import { socAlert, socEnrichment, socTriage } from './fixtures/soc-alert';

const context = {
  alert: socAlert,
  triage: socTriage,
  enrichment: socEnrichment,
  suppliedRunbooks: ['credential-brute-force.md'],
};

function investigation(overrides: Partial<SocInvestigation> = {}): SocInvestigation {
  return {
    summary: 'Brute force from 203.0.113.9',
    attackNarrative: '203.0.113.9 attacked jdoe on ws-042',
    evidence: ['AbuseIPDB 100% for 203.0.113.9'],
    recommendedResponse: 'contain',
    responseSteps: ['Block 203.0.113.9 [approval]'],
    confidence: 0.85,
    explanation: 'Intel and detection agree',
    citedRunbooks: ['credential-brute-force.md'],
    requiresHumanApproval: true,
    conflictsWithTriage: false,
    specialistReports: [
      { agent: 'triage_analyst', summary: 's', findings: ['f'], confidence: 0.8 },
      { agent: 'threat_intel', summary: 's', findings: ['f'], confidence: 0.8 },
      {
        agent: 'response_planner',
        summary: 's',
        findings: ['f'],
        confidence: 0.8,
        proposedResponse: 'contain',
        risk: 'medium',
      },
    ],
    model: 'm',
    graphVersion: 'soc-supervisor-v1',
    ...overrides,
  };
}

describe('evaluateSocInvestigation', () => {
  it('passes a grounded, approval-gated investigation', () => {
    const result = evaluateSocInvestigation(investigation(), context);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails on hallucinated IOCs that would end up in block lists', () => {
    const result = evaluateSocInvestigation(
      investigation({
        responseSteps: ['Block 203.0.113.9 and 198.51.100.77 [approval]'],
        evidence: ['Payload hash 44d88612fea8a8f36de82e1278abb02f seen'],
      }),
      context
    );
    expect(result.metrics.iocGrounded).toBe(false);
    expect(result.ungroundedIndicators.sort()).toEqual([
      '198.51.100.77',
      '44d88612fea8a8f36de82e1278abb02f',
    ]);
  });

  it('accepts defanged forms of known indicators', () => {
    const alert = {
      ...socAlert,
      indicators: [{ type: 'url' as const, value: 'hxxp://evil[.]example[.]net/p' }],
    };
    const result = evaluateSocInvestigation(
      investigation({
        summary: 'Download from http://evil.example.net/p',
        attackNarrative: 'n',
        evidence: ['e'],
        responseSteps: ['Block http://evil.example.net/p'],
      }),
      { ...context, alert, enrichment: null }
    );
    expect(result.metrics.iocGrounded).toBe(true);
  });

  it('fails when the cited runbook was not supplied', () => {
    const result = evaluateSocInvestigation(
      investigation({ citedRunbooks: ['made-up-runbook.md'] }),
      context
    );
    expect(result.metrics.runbookGrounded).toBe(false);
  });

  it('fails when containment bypasses approval', () => {
    const result = evaluateSocInvestigation(
      investigation({ requiresHumanApproval: false }),
      context
    );
    expect(result.metrics.safeContainmentPolicy).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when a triage conflict is not routed to a human', () => {
    const result = evaluateSocInvestigation(
      investigation({
        recommendedResponse: 'close',
        conflictsWithTriage: true,
        requiresHumanApproval: false,
        specialistReports: investigation().specialistReports.map((r) =>
          r.agent === 'response_planner' ? { ...r, risk: 'low' as const } : r
        ),
      }),
      context
    );
    expect(result.metrics.triageRespected).toBe(false);
  });

  it('fails on missing specialists and out-of-range confidence', () => {
    const result = evaluateSocInvestigation(
      investigation({ specialistReports: [], confidence: 1.4 }),
      context
    );
    expect(result.metrics.specialistCoverage).toBe(false);
    expect(result.metrics.confidenceInRange).toBe(false);
  });
});

describe('extractIndicators', () => {
  it('finds IPs, hashes and URLs but not version numbers or file names', () => {
    expect(
      extractIndicators(
        'Policy 2026.10.1, see credential-brute-force.md; block 8.8.8.8 and https://x.example.net/a. Hash ABCDEF0123456789ABCDEF0123456789.'
      ).sort()
    ).toEqual(['8.8.8.8', 'abcdef0123456789abcdef0123456789', 'https://x.example.net/a']);
  });

  it('refangs defanged indicators before extracting them', () => {
    expect(
      extractIndicators('Seen 198.51.100[.]7 calling hxxps://evil[.]example[.]com/payload').sort()
    ).toEqual(['198.51.100.7', 'https://evil.example.com/payload']);
  });

  it('finds IPv6 addresses but not clock times or MAC addresses', () => {
    expect(
      extractIndicators('From 2001:db8::7 at 10:32:45, NIC aa:bb:cc:dd:ee:ff, fe80::1%eth0').sort()
    ).toEqual(['2001:db8::7', 'fe80::1']);
  });

  it('finds bare domains under listed TLDs, skipping file names and e-mail domains', () => {
    expect(
      extractIndicators(
        'Beacon to c2-update.xyz and login.microsoft-verify.ru; ran powershell.exe; see runbook.md; mail from a@phish.example.com'
      ).sort()
    ).toEqual(['c2-update.xyz', 'login.microsoft-verify.ru']);
  });
});

describe('IOC grounding beyond IPv4/hash/URL', () => {
  it.each([
    ['domain-only', 'Block the C2 domain update-check.xyz'],
    ['IPv6', 'Traffic originated from 2001:db8:dead:beef::1'],
    ['defanged IPv4', 'Escalate 203.0.113[.]77 to the firewall team'],
    ['defanged URL', 'Payload hosted at hxxp://203.0.113.9.example.ru/a'],
  ])('flags a hallucinated %s indicator', (_label, text) => {
    const result = evaluateSocInvestigation(
      investigation({ evidence: ['AbuseIPDB 100% for 203.0.113.9', text] }),
      context
    );
    expect(result.metrics.iocGrounded).toBe(false);
  });

  it('accepts a defanged mention of a known indicator and the alert host', () => {
    const result = evaluateSocInvestigation(
      investigation({ evidence: ['203.0.113[.]9 hit ws-042 repeatedly'] }),
      context
    );
    expect(result.metrics.iocGrounded).toBe(true);
  });
});
