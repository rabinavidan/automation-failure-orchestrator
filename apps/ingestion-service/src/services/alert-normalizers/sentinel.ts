import { isIpAddress } from '@orchestrator/fingerprint-engine';
import type {
  Indicator,
  SecurityAlert,
  SecuritySeverity,
  SentinelAlert,
} from '@orchestrator/shared-types';
import { parseSplunkTime } from './splunk';

/**
 * Normalizes a Microsoft Sentinel alert (Logic App / automation-rule payload).
 *
 * Sentinel entities carry no traffic direction, so IP roles are inferred: public
 * addresses are treated as the external `source`, private ones as the internal
 * `destination`. This is a documented heuristic, visible in `raw`.
 */
export function normalizeSentinelAlert(
  payload: SentinelAlert,
  receivedAt: Date = new Date()
): SecurityAlert {
  const entities = parseEntities(payload.Entities);
  const indicators = entityIndicators(entities);
  const host = indicators.find((i) => i.type === 'host')?.value;
  const user = indicators.find((i) => i.type === 'user')?.value;

  const techniques = toList(payload.Techniques)
    .flatMap((t) => t.toUpperCase().match(/T\d{4}(?:\.\d{3})?/g) ?? [])
    .filter((t, i, all) => all.indexOf(t) === i);
  const tactics = toList(payload.Tactics).map(splitCamelCase);

  return {
    schemaVersion: '1.0.0',
    alertId: `sentinel:${payload.SystemAlertId}`,
    source: {
      vendor: 'sentinel',
      product: payload.ProductName ?? 'Microsoft Sentinel',
      ...(payload.AlertUri ? { resultsLink: payload.AlertUri } : {}),
    },
    ruleId: payload.AlertType ?? payload.AlertDisplayName,
    ruleName: payload.AlertDisplayName,
    title: payload.AlertDisplayName,
    description: payload.Description,
    severity: mapSentinelSeverity(payload.Severity),
    detectedAt: parseSplunkTime(payload.StartTimeUtc ?? payload.TimeGenerated, receivedAt),
    host,
    user,
    indicators,
    ...(techniques.length || tactics.length ? { mitre: { tactics, techniques } } : {}),
    raw: payload as unknown as Record<string, unknown>,
  };
}

export function mapSentinelSeverity(raw: string | undefined): SecuritySeverity {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    case 'informational':
      return 'informational';
    default:
      return 'medium';
  }
}

/** "CredentialAccess" -> "Credential Access", "CommandAndControl" -> "Command and Control". */
export function splitCamelCase(tactic: string): string {
  return tactic
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bAnd\b/g, 'and');
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : value.split(/[,;]/);
  return list.map((v) => v.trim()).filter(Boolean);
}

function parseEntities(raw: SentinelAlert['Entities']): Array<Record<string, unknown>> {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function entityIndicators(entities: Array<Record<string, unknown>>): Indicator[] {
  const out: Indicator[] = [];
  const add = (indicator: Indicator) => {
    if (!out.some((i) => i.type === indicator.type && i.value === indicator.value)) {
      out.push(indicator);
    }
  };

  for (const entity of entities) {
    switch (String(entity.Type ?? '').toLowerCase()) {
      case 'ip': {
        const address = str(entity.Address);
        if (address && isIpAddress(address)) {
          add({ type: 'ip', value: address, role: isPrivate(address) ? 'destination' : 'source' });
        }
        break;
      }
      case 'host': {
        const name = str(entity.HostName) ?? str(entity.NetBiosName);
        if (name) add({ type: 'host', value: name, role: 'destination' });
        break;
      }
      case 'account': {
        const name = str(entity.Name);
        const upn = str(entity.UPNSuffix);
        if (name) add({ type: 'user', value: upn ? `${name}@${upn}` : name, role: 'target' });
        break;
      }
      case 'file': {
        for (const hash of Array.isArray(entity.FileHashes) ? entity.FileHashes : []) {
          const value = str((hash as Record<string, unknown>)?.Value);
          if (value) add({ type: 'file_hash', value: value.toLowerCase(), role: 'observed' });
        }
        break;
      }
      case 'filehash': {
        const value = str(entity.Value);
        if (value) add({ type: 'file_hash', value: value.toLowerCase(), role: 'observed' });
        break;
      }
      case 'url': {
        const url = str(entity.Url);
        if (url) add({ type: 'url', value: url, role: 'observed' });
        break;
      }
      case 'dns': {
        const domain = str(entity.DomainName);
        if (domain) add({ type: 'domain', value: domain, role: 'observed' });
        break;
      }
      case 'process': {
        const image = processImageName(entity);
        if (image) add({ type: 'process', value: image, role: 'observed' });
        break;
      }
      case 'mailbox': {
        const mailbox = str(entity.MailboxPrimaryAddress);
        if (mailbox) add({ type: 'email', value: mailbox, role: 'target' });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Executable name: the explicit ImageFile entity if present, else the command line's first token. */
export function processImageName(entity: Record<string, unknown>): string | undefined {
  const imageFile = entity.ImageFile as Record<string, unknown> | undefined;
  const explicit = str(imageFile?.Name);
  if (explicit) return explicit;
  const commandLine = str(entity.CommandLine);
  if (!commandLine) return undefined;
  const executable = commandLine.match(/^"([^"]+)"/)?.[1] ?? commandLine.split(/\s+/)[0]!;
  return executable.split(/[\\/]/).pop() || undefined;
}

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./];

function isPrivate(ip: string): boolean {
  if (ip.includes(':')) return /^(fc|fd|fe80|::1$)/i.test(ip);
  return PRIVATE_V4.some((re) => re.test(ip));
}
