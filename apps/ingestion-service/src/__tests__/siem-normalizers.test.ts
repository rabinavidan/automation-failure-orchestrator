import { describe, it, expect } from 'vitest';
import { SecurityAlertSchema, TriagePolicySchema } from '@orchestrator/shared-types';
import { generateAlertFingerprint } from '@orchestrator/fingerprint-engine';
import { triageAlert } from '@orchestrator/failure-classifier';
import {
  mapSentinelSeverity,
  normalizeSentinelAlert,
  processImageName,
  splitCamelCase,
} from '../services/alert-normalizers/sentinel';
import { mapWazuhLevel, normalizeWazuhAlert } from '../services/alert-normalizers/wazuh';
import { normalizeSplunkAlert } from '../services/alert-normalizers/splunk';
import { VENDOR_NORMALIZERS } from '../services/alert-normalizers';
import { sentinelBruteForce, sentinelMalware, wazuhSshBruteForce } from './fixtures/siem-alerts';

describe('Microsoft Sentinel normalizer', () => {
  it('produces a contract-valid alert from the Logic App payload', () => {
    const alert = normalizeSentinelAlert(sentinelBruteForce);
    expect(SecurityAlertSchema.safeParse(alert).success).toBe(true);
    expect(alert).toMatchObject({
      alertId: 'sentinel:7d3e1a52-5b1c-4f0e-9d6a-2b9c8e1f0a11',
      source: { vendor: 'sentinel', product: 'Azure Sentinel' },
      severity: 'high',
      detectedAt: '2026-10-03T12:00:00.000Z',
      host: 'ws-042',
      user: 'jdoe@corp.example.com',
      mitre: {
        tactics: ['Credential Access', 'Initial Access'],
        techniques: ['T1110', 'T1110.003'],
      },
    });
  });

  it('parses string-encoded Entities and infers IP roles from address space', () => {
    expect(normalizeSentinelAlert(sentinelBruteForce).indicators).toEqual([
      { type: 'user', value: 'jdoe@corp.example.com', role: 'target' },
      { type: 'ip', value: '203.0.113.21', role: 'source' },
      { type: 'ip', value: '10.0.0.5', role: 'destination' },
      { type: 'host', value: 'ws-042', role: 'destination' },
    ]);
  });

  it('maps file hashes, URLs, processes, DNS and mailboxes; ignores unknown entities', () => {
    const types = normalizeSentinelAlert(sentinelMalware).indicators.map(
      (i) => `${i.type}:${i.value}`
    );
    expect(types).toEqual([
      'file_hash:44d88612fea8a8f36de82e1278abb02f',
      'url:http://evil.example.net/payload',
      'process:invoice.exe',
      'domain:evil.example.net',
      'email:jdoe@corp.example.com',
    ]);
  });

  it('extracts the executable from quoted/unquoted command lines and ImageFile', () => {
    expect(processImageName({ CommandLine: '"C:\\Program Files\\x\\a b.exe" -k' })).toBe('a b.exe');
    expect(processImageName({ CommandLine: '/usr/bin/curl -o /tmp/x http://e' })).toBe('curl');
    expect(processImageName({ ImageFile: { Name: 'powershell.exe' }, CommandLine: 'x' })).toBe(
      'powershell.exe'
    );
    expect(processImageName({})).toBeUndefined();
  });

  it('survives malformed Entities JSON', () => {
    const alert = normalizeSentinelAlert({ ...sentinelBruteForce, Entities: '{not json' });
    expect(alert.indicators).toEqual([]);
    expect(SecurityAlertSchema.safeParse(alert).success).toBe(true);
  });

  it('maps severities and tactic names', () => {
    expect(['High', 'medium', 'Low', 'Informational', undefined].map(mapSentinelSeverity)).toEqual([
      'high',
      'medium',
      'low',
      'informational',
      'medium',
    ]);
    expect(splitCamelCase('CommandAndControl')).toBe('Command and Control');
  });
});

describe('Wazuh normalizer', () => {
  it('produces a contract-valid alert with rule ATT&CK mapping', () => {
    const alert = normalizeWazuhAlert(wazuhSshBruteForce);
    expect(SecurityAlertSchema.safeParse(alert).success).toBe(true);
    expect(alert).toMatchObject({
      alertId: 'wazuh:1759492800.123456',
      ruleId: 'wazuh-rule-5712',
      severity: 'high',
      host: 'web-01',
      user: 'root',
      detectedAt: '2026-10-03T12:00:00.000Z',
      mitre: { tactics: ['Credential Access'], techniques: ['T1110'] },
    });
    expect(alert.indicators).toContainEqual({ type: 'ip', value: '203.0.113.22', role: 'source' });
  });

  it('maps rule levels 0-15 to severity', () => {
    expect([15, 12, 10, 7, 4, 2].map(mapWazuhLevel)).toEqual([
      'critical',
      'critical',
      'high',
      'medium',
      'low',
      'informational',
    ]);
  });
});

describe('vendor-agnostic pipeline', () => {
  const policy = TriagePolicySchema.parse({ version: 't', allowlist: [], knownBenign: [] });

  it('registers every supported SIEM', () => {
    expect(Object.keys(VENDOR_NORMALIZERS).sort()).toEqual(['sentinel', 'splunk', 'wazuh']);
  });

  it('the same brute-force attack triages identically from Splunk, Sentinel and Wazuh', () => {
    const splunk = normalizeSplunkAlert({
      sid: 's1',
      search_name: 'Access - Brute Force Access Behavior Detected - Rule',
      result: {
        _time: '1759492800',
        src: '203.0.113.30',
        dest: 'ws-1',
        user: 'u',
        urgency: 'high',
      },
    });
    const triages = [
      splunk,
      normalizeSentinelAlert(sentinelBruteForce),
      normalizeWazuhAlert(wazuhSshBruteForce),
    ].map((alert) =>
      triageAlert({
        alert,
        ingestionStatus: 'new',
        enrichment: null,
        occurrenceCount: 1,
        policy,
      })
    );
    for (const t of triages) {
      expect(t.disposition).toBe('needs_investigation');
      expect(t.mitre.techniques.map((x) => x.split('.')[0])).toContain('T1110');
      expect(t.mitre.tactics).toContain('Credential Access');
    }
  });

  it('fingerprints are vendor-scoped: the same entities from two SIEMs stay distinct', () => {
    const a = normalizeSentinelAlert(sentinelBruteForce);
    const fp = (vendor: 'sentinel' | 'splunk') =>
      generateAlertFingerprint({
        vendor,
        ruleId: a.ruleId,
        host: a.host,
        user: a.user,
        indicators: a.indicators,
      });
    expect(fp('sentinel')).not.toBe(fp('splunk'));
  });
});
