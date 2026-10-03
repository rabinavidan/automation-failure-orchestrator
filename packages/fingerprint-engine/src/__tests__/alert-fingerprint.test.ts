import { describe, it, expect } from 'vitest';
import {
  generateAlertFingerprint,
  alertFingerprintLabel,
  normalizeHost,
  normalizeUser,
  isIpAddress,
} from '../alert-fingerprint';
import type { AlertFingerprintInput } from '@orchestrator/shared-types';

const base: AlertFingerprintInput = {
  vendor: 'splunk',
  ruleId: 'Brute Force Access Behavior Detected',
  host: 'WS-042.corp.example.com',
  user: 'CORP\\jdoe',
  indicators: [
    { type: 'ip', value: '203.0.113.7', role: 'source' },
    { type: 'host', value: 'ws-042', role: 'destination' },
  ],
};

describe('identity normalization', () => {
  it('strips DNS suffix and lowercases hosts', () => {
    expect(normalizeHost('WS-042.corp.example.com')).toBe('ws-042');
  });

  it('keeps IP addresses intact when used as host', () => {
    expect(normalizeHost('10.0.0.15')).toBe('10.0.0.15');
  });

  it('collapses DOMAIN\\user, UPN and casing to one identity', () => {
    expect(normalizeUser('CORP\\JDoe')).toBe('jdoe');
    expect(normalizeUser('jdoe@corp.example.com')).toBe('jdoe');
    expect(normalizeUser(' JDOE ')).toBe('jdoe');
  });

  it('detects IPv4 and IPv6 addresses', () => {
    expect(isIpAddress('203.0.113.7')).toBe(true);
    expect(isIpAddress('2001:db8::1')).toBe(true);
    expect(isIpAddress('999.1.1.1')).toBe(false);
    expect(isIpAddress('ws-042')).toBe(false);
  });
});

describe('generateAlertFingerprint', () => {
  it('produces a 64-char hex SHA-256', () => {
    expect(generateAlertFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across host/user spelling variants', () => {
    const variant = generateAlertFingerprint({
      ...base,
      host: 'ws-042',
      user: 'jdoe@corp.example.com',
    });
    expect(variant).toBe(generateAlertFingerprint(base));
  });

  it('is independent of indicator order and duplicates', () => {
    const reordered = generateAlertFingerprint({
      ...base,
      indicators: [...base.indicators].reverse().concat(base.indicators[0]!),
    });
    expect(reordered).toBe(generateAlertFingerprint(base));
  });

  it('differs when the source IP changes', () => {
    const other = generateAlertFingerprint({
      ...base,
      indicators: [{ type: 'ip', value: '198.51.100.9', role: 'source' }, base.indicators[1]!],
    });
    expect(other).not.toBe(generateAlertFingerprint(base));
  });

  it('differs between vendors and rules', () => {
    const fp = generateAlertFingerprint(base);
    expect(generateAlertFingerprint({ ...base, vendor: 'sentinel' })).not.toBe(fp);
    expect(generateAlertFingerprint({ ...base, ruleId: 'Other rule' })).not.toBe(fp);
  });

  it('builds a 12-char label for ticket correlation', () => {
    const fp = generateAlertFingerprint(base);
    expect(alertFingerprintLabel(fp)).toBe(`security-alert-fingerprint-${fp.slice(0, 12)}`);
  });
});
