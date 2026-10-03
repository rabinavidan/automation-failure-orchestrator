import { isIpAddress } from '@orchestrator/fingerprint-engine';
import type {
  Indicator,
  SecurityAlert,
  SecuritySeverity,
  WazuhAlert,
} from '@orchestrator/shared-types';
import { parseSplunkTime } from './splunk';

/**
 * Normalizes a Wazuh alert delivered by a custom integration. Wazuh already maps
 * many rules to ATT&CK (`rule.mitre`), and its 0-15 rule level maps onto severity.
 */
export function normalizeWazuhAlert(
  payload: WazuhAlert,
  receivedAt: Date = new Date()
): SecurityAlert {
  const data = payload.data ?? {};
  const syscheck = payload.syscheck ?? {};
  const indicators: Indicator[] = [];
  const add = (type: Indicator['type'], value: unknown, role: Indicator['role']) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const v = value.trim();
    if (type === 'ip' && !isIpAddress(v)) return;
    if (!indicators.some((i) => i.type === type && i.value === v && i.role === role)) {
      indicators.push({ type, value: v, role });
    }
  };

  add('ip', data.srcip, 'source');
  add('ip', data.dstip, 'destination');
  add('host', payload.agent?.name, 'destination');
  add('user', data.dstuser, 'target');
  add('user', data.srcuser, 'source');
  add('url', data.url, 'observed');
  add('file_hash', syscheck.sha256_after ?? syscheck.md5_after, 'observed');
  add('process', data.process_name ?? data.program_name, 'observed');

  const techniques = (payload.rule.mitre?.id ?? []).filter((t) => /^T\d{4}(\.\d{3})?$/.test(t));

  return {
    schemaVersion: '1.0.0',
    alertId: `wazuh:${payload.id}`,
    source: { vendor: 'wazuh', product: 'Wazuh' },
    ruleId: `wazuh-rule-${payload.rule.id}`,
    ruleName: payload.rule.description,
    title: payload.rule.description,
    severity: mapWazuhLevel(payload.rule.level),
    detectedAt: parseSplunkTime(payload.timestamp, receivedAt),
    host: payload.agent?.name,
    user: typeof data.dstuser === 'string' ? data.dstuser : undefined,
    indicators,
    ...(techniques.length || payload.rule.mitre?.tactic?.length
      ? { mitre: { tactics: payload.rule.mitre?.tactic ?? [], techniques } }
      : {}),
    raw: payload as unknown as Record<string, unknown>,
  };
}

/** Wazuh rule levels: 0-15 (higher is more severe). */
export function mapWazuhLevel(level: number): SecuritySeverity {
  if (level >= 12) return 'critical';
  if (level >= 10) return 'high';
  if (level >= 7) return 'medium';
  if (level >= 4) return 'low';
  return 'informational';
}
