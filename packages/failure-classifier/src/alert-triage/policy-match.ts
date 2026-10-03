import type { SecurityAlert, TriagePolicyEntry } from '@orchestrator/shared-types';
import { normalizeHost, normalizeUser } from '@orchestrator/fingerprint-engine';

export function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** IPv4 exact or CIDR match; other address families compare exactly (case-insensitive). */
export function ipMatches(pattern: string, ip: string): boolean {
  const [network, bitsRaw] = pattern.split('/');
  if (bitsRaw === undefined) return pattern.trim().toLowerCase() === ip.trim().toLowerCase();

  const bits = Number(bitsRaw);
  const net = ipv4ToInt(network ?? '');
  const addr = ipv4ToInt(ip.trim());
  if (net === null || addr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(net / size) === Math.floor(addr / size);
}

function indicatorMatches(
  criterion: NonNullable<TriagePolicyEntry['match']['indicator']>,
  alert: SecurityAlert
): boolean {
  return alert.indicators.some((indicator) => {
    if (indicator.type !== criterion.type) return false;
    switch (criterion.type) {
      case 'ip':
        return ipMatches(criterion.value, indicator.value);
      case 'host':
        return normalizeHost(criterion.value) === normalizeHost(indicator.value);
      case 'user':
        return normalizeUser(criterion.value) === normalizeUser(indicator.value);
      default:
        return wildcardMatch(criterion.value, indicator.value.trim());
    }
  });
}

export function entryMatches(entry: TriagePolicyEntry, alert: SecurityAlert, now: Date): boolean {
  if (new Date(entry.expiresAt).getTime() <= now.getTime()) return false;

  const { ruleId, host, user, indicator } = entry.match;
  if (ruleId && !(wildcardMatch(ruleId, alert.ruleId) || wildcardMatch(ruleId, alert.ruleName))) {
    return false;
  }
  if (host && (!alert.host || normalizeHost(host) !== normalizeHost(alert.host))) return false;
  if (user && (!alert.user || normalizeUser(user) !== normalizeUser(alert.user))) return false;
  if (indicator && !indicatorMatches(indicator, alert)) return false;
  return true;
}

export function findMatchingEntry(
  entries: TriagePolicyEntry[],
  alert: SecurityAlert,
  now: Date
): TriagePolicyEntry | undefined {
  return entries.find((entry) => entryMatches(entry, alert, now));
}
