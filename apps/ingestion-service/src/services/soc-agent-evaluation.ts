import { isIPv6 } from 'node:net';
import type {
  AlertTriage,
  EnrichmentResponse,
  SecurityAlert,
  SocEvaluationResult,
  SocInvestigation,
} from '@orchestrator/shared-types';

const REQUIRED_SPECIALISTS = ['triage_analyst', 'threat_intel', 'response_planner'] as const;

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const HASH = /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi;
const URL = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
/** Candidate IPv6 tokens; each is confirmed with net.isIPv6 so times and MACs are not matched. */
const IPV6_CANDIDATE = /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b/gi;
/**
 * Only names under these TLDs count as domain IOCs. An allowlist keeps file names
 * (credential-brute-force.md, powershell.exe) and prose out of the gate; a domain under an
 * unlisted TLD is not checked. This is a documented coverage limit, not full domain coverage.
 */
const DOMAIN_TLDS = new Set(
  (
    'com net org io info biz xyz top online site club live shop app dev cloud tech store ' +
    'ru su cn tk ml ga cf gq pw cc ws me co us uk de fr nl it es pl br in jp kr ir ua kz vn ' +
    'id tr ro cz hu ch at be se no fi dk pt gr il au ca mx ar za eu asia'
  ).split(' ')
);

function refang(value: string): string {
  return value
    .trim()
    .replace(/^hxxp/i, 'http')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\[:\]/g, ':');
}

/** Undo common defanging anywhere in free text so defanged IOCs are checked like plain ones. */
export function refangText(text: string): string {
  return text
    .replace(/\bhxxp(s?):\/\//gi, 'http$1://')
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/gi, '.')
    .replace(/\[:\]/g, ':');
}

function hostOf(value: string): string | undefined {
  try {
    return new globalThis.URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Network/file IOCs mentioned anywhere in the investigation text, including defanged forms. */
export function extractIndicators(text: string): string[] {
  const plain = refangText(text);
  const urls = (plain.match(URL) ?? []).map((u) => u.replace(/[.,;:]+$/, ''));
  const urlHosts = new Set(urls.map(hostOf).filter((h): h is string => Boolean(h)));
  const ipv6 = (plain.match(IPV6_CANDIDATE) ?? []).filter((c) => isIPv6(c));
  const domains = [...plain.matchAll(DOMAIN)]
    .filter((m) => DOMAIN_TLDS.has(m[1].toLowerCase()))
    // Skip the domain part of e-mail addresses; the address itself is the indicator.
    .filter((m) => plain[(m.index ?? 0) - 1] !== '@')
    .map((m) => m[0])
    // A URL's own host is part of that URL indicator, not a separate one.
    .filter((d) => !urlHosts.has(d.toLowerCase()));
  const found = [
    ...(plain.match(IPV4) ?? []),
    ...(plain.match(HASH) ?? []),
    ...urls,
    ...ipv6,
    ...domains,
  ];
  return [...new Set(found.map((v) => v.toLowerCase()))];
}

/**
 * Deterministic evaluation gate for SOC investigations (no LLM judge):
 * - iocGrounded: every IP / hash / URL the agents mention must exist in the alert's
 *   indicators or the enrichment results. Catches hallucinated IOCs, which would
 *   otherwise end up in block lists.
 * - runbookGrounded: the response cites at least one runbook that was actually supplied.
 * - safeContainmentPolicy: containment, or high-risk planning, always requires approval.
 * - triageRespected: disagreement with the deterministic triage is flagged for a human.
 */
export function evaluateSocInvestigation(
  investigation: SocInvestigation,
  context: {
    alert: SecurityAlert;
    triage: AlertTriage;
    enrichment: EnrichmentResponse | null;
    suppliedRunbooks: string[];
  }
): SocEvaluationResult {
  const known = new Set<string>();
  const addKnown = (value: string) => {
    const v = refang(value).toLowerCase();
    known.add(v);
    const host = hostOf(v);
    if (host) known.add(host);
    if (v.includes('@')) known.add(v.slice(v.lastIndexOf('@') + 1));
  };
  for (const i of context.alert.indicators) addKnown(i.value);
  for (const e of context.enrichment?.enrichments ?? []) {
    addKnown(e.normalizedValue);
    addKnown(e.indicator.value);
  }
  if (context.alert.host) addKnown(context.alert.host);

  const text = [
    investigation.summary,
    investigation.attackNarrative,
    investigation.explanation,
    ...investigation.evidence,
    ...investigation.responseSteps,
    ...investigation.specialistReports.flatMap((r) => [r.summary, ...r.findings]),
  ].join('\n');
  const ungroundedIndicators = extractIndicators(text).filter((ioc) => !known.has(ioc));

  const reports = investigation.specialistReports;
  const planner = reports.find((r) => r.agent === 'response_planner');

  const metrics = {
    schemaComplete: Boolean(
      investigation.summary.trim() &&
      investigation.explanation.trim() &&
      investigation.evidence.length > 0 &&
      investigation.responseSteps.length > 0 &&
      investigation.model.trim()
    ),
    specialistCoverage: REQUIRED_SPECIALISTS.every((agent) =>
      reports.some((r) => r.agent === agent)
    ),
    iocGrounded: ungroundedIndicators.length === 0,
    runbookGrounded:
      investigation.citedRunbooks.length > 0 &&
      investigation.citedRunbooks.every((rb) => context.suppliedRunbooks.includes(rb)),
    safeContainmentPolicy:
      (investigation.recommendedResponse !== 'contain' && planner?.risk !== 'high') ||
      investigation.requiresHumanApproval,
    triageRespected: !investigation.conflictsWithTriage || investigation.requiresHumanApproval,
    confidenceInRange:
      investigation.confidence >= 0 &&
      investigation.confidence <= 1 &&
      reports.every((r) => r.confidence >= 0 && r.confidence <= 1),
  };

  const labels: Record<keyof typeof metrics, string> = {
    schemaComplete: 'required investigation fields are incomplete',
    specialistCoverage: 'required SOC specialist reports are missing',
    iocGrounded: `investigation mentions indicators absent from the alert and enrichment: ${ungroundedIndicators.join(', ')}`,
    runbookGrounded: 'response does not cite a supplied runbook',
    safeContainmentPolicy: 'containment or high-risk response bypassed human approval',
    triageRespected: 'disagreement with deterministic triage was not routed to a human',
    confidenceInRange: 'confidence is outside the 0..1 range',
  };
  const keys = Object.keys(metrics) as Array<keyof typeof metrics>;
  const failures = keys.filter((k) => !metrics[k]).map((k) => labels[k]);
  return {
    passed: failures.length === 0,
    score: keys.filter((k) => metrics[k]).length / keys.length,
    metrics,
    failures,
    ungroundedIndicators,
  };
}
