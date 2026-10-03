import { describe, it, expect } from 'vitest';
import { SecurityAlertSchema } from '@orchestrator/shared-types';
import {
  normalizeSplunkAlert,
  mapSeverity,
  parseSplunkTime,
  extractIndicators,
  extractMitre,
} from '../services/alert-normalizers/splunk';
import { splunkBruteForceAlert, splunkMalwareAlert } from './fixtures/splunk-alerts';

const receivedAt = new Date('2025-10-03T15:00:00Z');

describe('normalizeSplunkAlert', () => {
  it('produces a contract-valid SecurityAlert', () => {
    const alert = normalizeSplunkAlert(splunkBruteForceAlert, receivedAt);
    expect(SecurityAlertSchema.safeParse(alert).success).toBe(true);
  });

  it('maps CIM fields onto the normalized alert', () => {
    const alert = normalizeSplunkAlert(splunkBruteForceAlert, receivedAt);
    expect(alert.source).toMatchObject({
      vendor: 'splunk',
      product: 'SplunkEnterpriseSecuritySuite',
    });
    expect(alert.ruleName).toBe('Access - Brute Force Access Behavior Detected - Rule');
    expect(alert.title).toBe('Brute Force Access Behavior Detected');
    expect(alert.severity).toBe('high');
    expect(alert.host).toBe('WS-042.corp.example.com');
    expect(alert.user).toBe('CORP\\jdoe');
    expect(alert.eventCount).toBe(57);
    expect(alert.detectedAt).toBe('2025-10-03T14:00:00.000Z');
    expect(alert.mitre).toEqual({
      tactics: ['Credential Access'],
      techniques: ['T1110', 'T1110.001'],
    });
  });

  it('derives a stable alertId so webhook retries are idempotent', () => {
    const a = normalizeSplunkAlert(splunkBruteForceAlert, receivedAt);
    const reordered = {
      ...splunkBruteForceAlert,
      result: Object.fromEntries(Object.entries(splunkBruteForceAlert.result).reverse()),
    };
    const b = normalizeSplunkAlert(reordered, new Date());
    expect(a.alertId).toBe(b.alertId);
    expect(a.alertId).toMatch(/^splunk:scheduler__.+:[0-9a-f]{12}$/);
  });

  it('gives different result rows of the same search different alertIds', () => {
    const other = {
      ...splunkBruteForceAlert,
      result: { ...splunkBruteForceAlert.result, src: '198.51.100.9' },
    };
    expect(normalizeSplunkAlert(other).alertId).not.toBe(
      normalizeSplunkAlert(splunkBruteForceAlert).alertId
    );
  });

  it('does not use an IP address as the host name', () => {
    const alert = normalizeSplunkAlert(splunkMalwareAlert, receivedAt);
    expect(alert.host).toBe('srv-db-01');
    const noHostname = normalizeSplunkAlert({
      ...splunkMalwareAlert,
      result: { ...splunkMalwareAlert.result, dest_host: undefined },
    });
    expect(noHostname.host).toBeUndefined();
  });
});

describe('extractIndicators', () => {
  it('routes ambiguous src/dest values by shape (IP vs hostname)', () => {
    const indicators = extractIndicators(splunkBruteForceAlert.result);
    expect(indicators).toContainEqual({ type: 'ip', value: '203.0.113.7', role: 'source' });
    expect(indicators).toContainEqual({
      type: 'host',
      value: 'WS-042.corp.example.com',
      role: 'destination',
    });
    expect(indicators.find((i) => i.type === 'host' && i.value === '203.0.113.7')).toBeUndefined();
  });

  it('extracts hashes, URLs, processes and users', () => {
    const types = extractIndicators(splunkMalwareAlert.result).map((i) => `${i.type}:${i.value}`);
    expect(types).toEqual(
      expect.arrayContaining([
        'ip:10.20.30.40',
        'host:srv-db-01',
        'file_hash:44d88612fea8a8f36de82e1278abb02f',
        'process:invoice.exe',
        'url:http://malicious.example.net/payload',
        'user:svc_backup@corp.example.com',
      ])
    );
  });

  it('handles multivalue fields and drops placeholder values', () => {
    const indicators = extractIndicators({
      src_ip: ['1.1.1.1', '8.8.8.8'],
      dest: 'unknown',
      user: '-',
    });
    expect(indicators).toEqual([
      { type: 'ip', value: '1.1.1.1', role: 'source' },
      { type: 'ip', value: '8.8.8.8', role: 'source' },
    ]);
  });
});

describe('extractMitre', () => {
  it('pulls technique IDs out of free text and dedupes', () => {
    expect(
      extractMitre({
        mitre_technique: 'Brute Force (T1110), t1110',
        mitre_tactic: 'TA0006; Credential Access',
      })
    ).toEqual({ techniques: ['T1110'], tactics: ['TA0006', 'Credential Access'] });
  });

  it('returns undefined when no ATT&CK annotations exist', () => {
    expect(extractMitre({ signature: 'x' })).toBeUndefined();
  });
});

describe('mapSeverity', () => {
  it.each([
    ['critical', 'critical'],
    ['High', 'high'],
    ['info', 'informational'],
    ['1', 'informational'],
    ['3', 'medium'],
    ['4', 'high'],
    ['5', 'critical'],
    ['bogus', 'medium'],
    [undefined, 'medium'],
  ])('%s -> %s', (input, expected) => {
    expect(mapSeverity(input)).toBe(expected);
  });
});

describe('parseSplunkTime', () => {
  it('parses epoch seconds and ISO strings, falling back on garbage', () => {
    expect(parseSplunkTime('1759500000.5', receivedAt)).toBe('2025-10-03T14:00:00.500Z');
    expect(parseSplunkTime('2025-10-03T14:00:00+02:00', receivedAt)).toBe(
      '2025-10-03T12:00:00.000Z'
    );
    expect(parseSplunkTime('not-a-time', receivedAt)).toBe(receivedAt.toISOString());
    expect(parseSplunkTime(undefined, receivedAt)).toBe(receivedAt.toISOString());
  });
});
