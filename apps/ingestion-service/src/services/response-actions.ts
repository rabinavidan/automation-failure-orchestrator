import { alertFingerprintLabel, normalizeHost } from '@orchestrator/fingerprint-engine';
import { ipMatches } from '@orchestrator/failure-classifier';
import type {
  AlertTriage,
  ResponseActionType,
  SecurityAlert,
  TriagePolicy,
} from '@orchestrator/shared-types';
import { addComment, createIssue, searchByLabel } from './jira-adapter';

export interface ActionRequest {
  action: ResponseActionType;
  targetValue: string;
  alert: SecurityAlert;
  triage: AlertTriage;
  fingerprint: string;
  actor: string;
  reason: string;
}

export interface ActionDeps {
  fetch: typeof fetch;
}

const REVERSIBLE: Partial<Record<ResponseActionType, true>> = {
  'firewall.block_ip': true,
  'edr.isolate_host': true,
};

export function isReversible(action: ResponseActionType): boolean {
  return REVERSIBLE[action] === true;
}

function actionsBaseUrl(): string {
  return (process.env.SOC_ACTIONS_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Blast-radius guards: deterministic refusals, evaluated when an action is
// planned AND again right before it executes (policy may change in between).
// ---------------------------------------------------------------------------

const NEVER_BLOCK_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '255.255.255.255/32',
];

function protectedHosts(): Set<string> {
  return new Set(
    (process.env.SOC_PROTECTED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
      .map(normalizeHost)
  );
}

export function guardAction(
  action: ResponseActionType,
  targetValue: string,
  policy: TriagePolicy,
  now: Date = new Date()
): string | null {
  if (action === 'firewall.block_ip') {
    const ip = targetValue.trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !ip.includes(':'))
      return 'target is not an IP address';
    if (ip.includes(':')) {
      const lower = ip.toLowerCase();
      if (
        lower === '::1' ||
        lower.startsWith('fe80:') ||
        lower.startsWith('fc') ||
        lower.startsWith('fd')
      ) {
        return 'refusing to block a non-public IPv6 address';
      }
    } else if (NEVER_BLOCK_V4.some((cidr) => ipMatches(cidr, ip))) {
      return 'refusing to block a private, loopback, link-local or multicast address';
    }
    const allowlisted = policy.allowlist.find(
      (e) =>
        new Date(e.expiresAt) > now &&
        e.match.indicator?.type === 'ip' &&
        ipMatches(e.match.indicator.value, ip)
    );
    if (allowlisted) return `IP is allowlisted by triage policy "${allowlisted.id}"`;
  }

  // Isolation is what causes outages; killing a malicious process on a protected host
  // (whose target is a process name, not a host) stays allowed with approval.
  if (action === 'edr.isolate_host') {
    if (protectedHosts().has(normalizeHost(targetValue))) {
      return 'host is on the protected list (SOC_PROTECTED_HOSTS); isolating it risks an outage';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

async function call(deps: ActionDeps, method: string, path: string, body?: unknown): Promise<void> {
  const response = await deps.fetch(`${actionsBaseUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
}

function hostOf(alert: SecurityAlert): string | undefined {
  return alert.host ?? alert.indicators.find((i) => i.type === 'host')?.value;
}

/** Executes one action. Throws on failure; returns a short human-readable result. */
export async function executeAction(req: ActionRequest, deps: ActionDeps): Promise<string> {
  const { alert, triage } = req;
  switch (req.action) {
    case 'ticket.create': {
      const label = alertFingerprintLabel(req.fingerprint);
      const existing = await searchByLabel(label);
      const summaryLine = `${triage.priority} ${triage.disposition}: ${alert.title}`;
      const evidence = triage.reasons.map((r) => `- ${r}`).join('\n');
      if (existing) {
        await addComment(
          existing.key,
          `Recurrence (${alert.alertId}): ${summaryLine}\n${evidence}`
        );
        return `updated ${existing.key}`;
      }
      const key = await createIssue({
        summary: `[SOC] ${summaryLine}`.slice(0, 250),
        description: `Alert ${alert.alertId}\nRule: ${alert.ruleName}\nRisk: ${triage.riskScore}\nATT&CK: ${triage.mitre.techniques.join(', ') || 'n/a'}\n\n${evidence}`,
        labels: [label, 'security-alert', `soc-${triage.priority.toLowerCase()}`],
        priority:
          triage.priority === 'P1' ? 'Highest' : triage.priority === 'P2' ? 'High' : 'Medium',
      });
      if (!key) throw new Error('ticket creation failed');
      return `created ${key}`;
    }
    case 'slack.notify': {
      const url = process.env.SLACK_WEBHOOK_URL;
      if (!url) throw new Error('SLACK_WEBHOOK_URL not configured');
      const text = `:rotating_light: *${triage.priority} ${triage.disposition}* ${alert.title}\nHost: ${hostOf(alert) ?? 'n/a'} | User: ${alert.user ?? 'n/a'} | Risk ${triage.riskScore}\n${triage.reasons[0] ?? ''}`;
      const response = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
      return 'notified SOC channel';
    }
    case 'firewall.block_ip':
      await call(deps, 'POST', '/firewall/blocks', {
        ip: req.targetValue,
        reason: req.reason,
        requestedBy: req.actor,
      });
      return `blocked ${req.targetValue}`;
    case 'edr.isolate_host':
      await call(deps, 'POST', `/edr/hosts/${encodeURIComponent(req.targetValue)}/isolate`, {
        reason: req.reason,
        requestedBy: req.actor,
      });
      return `isolated ${req.targetValue}`;
    case 'edr.kill_process': {
      const host = hostOf(alert);
      if (!host) throw new Error('no host to kill the process on');
      await call(deps, 'POST', '/edr/processes/kill', {
        host,
        process: req.targetValue,
        requestedBy: req.actor,
      });
      return `killed ${req.targetValue} on ${host}`;
    }
  }
}

export async function rollbackAction(
  action: ResponseActionType,
  targetValue: string,
  actor: string,
  deps: ActionDeps
): Promise<string> {
  switch (action) {
    case 'firewall.block_ip':
      await call(deps, 'DELETE', `/firewall/blocks/${encodeURIComponent(targetValue)}`);
      return `unblocked ${targetValue}`;
    case 'edr.isolate_host':
      await call(deps, 'POST', `/edr/hosts/${encodeURIComponent(targetValue)}/release`, {
        requestedBy: actor,
      });
      return `released ${targetValue}`;
    default:
      throw new Error(`${action} is not reversible`);
  }
}
