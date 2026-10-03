import { createHash } from 'crypto';
import type { AlertFingerprintInput, Indicator } from '@orchestrator/shared-types';

/**
 * Alert fingerprints identify the same logical detection on the same entities,
 * independent of when it fired or which search job produced it:
 *
 *   SHA256(vendor | ruleId | host | user | sorted indicators)
 *
 * Volatile fields (timestamps, sid, event counts, raw payload) are excluded so
 * repeated firings collapse onto one fingerprint for deduplication/suppression.
 */

/** `WS-042.corp.example.com` -> `ws-042` */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  // Keep IP addresses intact; only strip DNS suffixes from hostnames.
  if (isIpAddress(trimmed)) return trimmed;
  return trimmed.split('.')[0] ?? trimmed;
}

/** `CORP\jdoe`, `jdoe@corp.example.com`, `JDoe` -> `jdoe` */
export function normalizeUser(user: string): string {
  let value = user.trim().toLowerCase();
  const backslash = value.lastIndexOf('\\');
  if (backslash >= 0) value = value.slice(backslash + 1);
  const at = value.indexOf('@');
  if (at > 0) value = value.slice(0, at);
  return value;
}

export function normalizeIndicator(indicator: Indicator): string {
  let value: string;
  switch (indicator.type) {
    case 'host':
      value = normalizeHost(indicator.value);
      break;
    case 'user':
      value = normalizeUser(indicator.value);
      break;
    case 'domain':
      value = indicator.value.trim().toLowerCase().replace(/\.$/, '');
      break;
    default:
      value = indicator.value.trim().toLowerCase();
  }
  return `${indicator.type}:${indicator.role ?? 'observed'}:${value}`;
}

export function generateAlertFingerprint(input: AlertFingerprintInput): string {
  const indicators = [...new Set(input.indicators.map(normalizeIndicator))].sort();
  const normalized = [
    input.vendor,
    input.ruleId.trim().toLowerCase(),
    input.host ? normalizeHost(input.host) : '',
    input.user ? normalizeUser(input.user) : '',
    indicators.join(','),
  ].join('|');

  return createHash('sha256').update(normalized).digest('hex');
}

export function alertFingerprintLabel(fp: string): string {
  return `security-alert-fingerprint-${fp.slice(0, 12)}`;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function isIpAddress(value: string): boolean {
  const v = value.trim();
  return IPV4.test(v) || (v.includes(':') && v.split(':').length >= 3 && IPV6.test(v));
}
