import { createHash } from 'crypto';
import { isIpAddress } from '@orchestrator/fingerprint-engine';
import type {
  Indicator,
  SecurityAlert,
  SecuritySeverity,
  SplunkAlertWebhook,
} from '@orchestrator/shared-types';

/**
 * Normalizes a Splunk webhook alert action payload into the vendor-agnostic
 * SecurityAlert contract. Field names follow the Splunk Common Information
 * Model (CIM); multivalue fields may arrive as arrays.
 */
export function normalizeSplunkAlert(
  payload: SplunkAlertWebhook,
  receivedAt: Date = new Date()
): SecurityAlert {
  const r = payload.result;

  const host = first(r, 'dest_host', 'dest', 'host');
  const user = first(r, 'user', 'src_user', 'dest_user');
  const title = first(r, 'signature', 'rule_title', 'title') ?? payload.search_name;

  return {
    schemaVersion: '1.0.0',
    alertId: `splunk:${payload.sid}:${hashResult(r)}`,
    source: {
      vendor: 'splunk',
      product: payload.app,
      searchName: payload.search_name,
      resultsLink: payload.results_link,
    },
    ruleId: first(r, 'rule_id') ?? payload.search_name,
    ruleName: payload.search_name,
    title,
    description: first(r, 'description', 'rule_description'),
    severity: mapSeverity(first(r, 'urgency', 'severity')),
    detectedAt: parseSplunkTime(first(r, '_time'), receivedAt),
    host: host && !isIpAddress(host) ? host : undefined,
    user,
    indicators: extractIndicators(r),
    mitre: extractMitre(r),
    eventCount: parseCount(first(r, 'count', 'event_count')),
    raw: payload as unknown as Record<string, unknown>,
  };
}

type FieldSpec = {
  fields: string[];
  type: Indicator['type'];
  role: NonNullable<Indicator['role']>;
};

// CIM field -> indicator mapping. `src`/`dest` may hold either an IP or a hostname.
const INDICATOR_FIELDS: FieldSpec[] = [
  { fields: ['src_ip', 'src'], type: 'ip', role: 'source' },
  { fields: ['dest_ip', 'dest'], type: 'ip', role: 'destination' },
  { fields: ['src_host', 'src'], type: 'host', role: 'source' },
  { fields: ['dest_host', 'dest', 'host'], type: 'host', role: 'destination' },
  { fields: ['user', 'dest_user'], type: 'user', role: 'target' },
  { fields: ['src_user'], type: 'user', role: 'source' },
  { fields: ['file_hash', 'sha256', 'sha1', 'md5'], type: 'file_hash', role: 'observed' },
  { fields: ['url'], type: 'url', role: 'observed' },
  { fields: ['domain', 'query', 'dest_domain'], type: 'domain', role: 'observed' },
  { fields: ['process', 'process_name'], type: 'process', role: 'observed' },
  { fields: ['sender', 'src_user_email'], type: 'email', role: 'source' },
  { fields: ['recipient'], type: 'email', role: 'target' },
];

export function extractIndicators(result: Record<string, unknown>): Indicator[] {
  const seen = new Set<string>();
  const indicators: Indicator[] = [];

  for (const spec of INDICATOR_FIELDS) {
    for (const field of spec.fields) {
      for (const value of values(result[field])) {
        const ip = isIpAddress(value);
        // Route ambiguous src/dest/host values by shape.
        if (spec.type === 'ip' && !ip) continue;
        if (spec.type === 'host' && ip) continue;

        const key = `${spec.type}:${spec.role}:${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        indicators.push({ type: spec.type, value, role: spec.role });
      }
    }
  }

  return indicators;
}

const TECHNIQUE_ID = /T\d{4}(?:\.\d{3})?/g;

export function extractMitre(result: Record<string, unknown>): SecurityAlert['mitre'] | undefined {
  const techniqueSources = [
    ...values(result['mitre_technique_id']),
    ...values(result['mitre_technique']),
    ...values(result['annotations.mitre_attack']),
    ...values(result['annotations.mitre_attack.mitre_technique_id']),
  ];
  const techniques = [
    ...new Set(techniqueSources.flatMap((v) => v.toUpperCase().match(TECHNIQUE_ID) ?? [])),
  ];
  const tactics = [
    ...new Set(
      [
        ...values(result['mitre_tactic']),
        ...values(result['annotations.mitre_attack.mitre_tactic']),
      ].flatMap(splitList)
    ),
  ];

  if (techniques.length === 0 && tactics.length === 0) return undefined;
  return { tactics, techniques };
}

/**
 * Accepts Splunk ES urgency strings or numeric `alert.severity`
 * (1=debug, 2=info, 3=warn, 4=error, 5=severe, 6=fatal).
 */
export function mapSeverity(raw: string | undefined): SecuritySeverity {
  if (!raw) return 'medium';
  const value = raw.trim().toLowerCase();
  const numeric: Record<string, SecuritySeverity> = {
    '1': 'informational',
    '2': 'informational',
    '3': 'medium',
    '4': 'high',
    '5': 'critical',
    '6': 'critical',
  };
  if (numeric[value]) return numeric[value];
  if (value === 'info' || value === 'informational') return 'informational';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value;
  }
  return 'medium';
}

/** `_time` arrives as epoch seconds ("1700000000.123") or an ISO string. */
export function parseSplunkTime(raw: string | undefined, fallback: Date): string {
  if (raw) {
    const trimmed = raw.trim();
    const epoch = Number(trimmed);
    const date =
      Number.isFinite(epoch) && trimmed !== '' ? new Date(epoch * 1000) : new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback.toISOString();
}

function parseCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function values(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim())
    .filter((v) => v !== '' && v !== 'unknown' && v !== '-');
}

function first(result: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const [value] = values(result[field]);
    if (value) return value;
  }
  return undefined;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;|]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Stable hash of the result row so webhook retries map to the same alertId. */
function hashResult(result: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(result)).digest('hex').slice(0, 12);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
