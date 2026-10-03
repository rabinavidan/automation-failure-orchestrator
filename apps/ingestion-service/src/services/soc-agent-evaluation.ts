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

function refang(value: string): string {
  return value
    .trim()
    .replace(/^hxxp/i, 'http')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\[:\]/g, ':');
}

/** Network/file IOCs mentioned anywhere in the investigation text. */
export function extractIndicators(text: string): string[] {
  const found = [
    ...(text.match(IPV4) ?? []),
    ...(text.match(HASH) ?? []),
    ...(text.match(URL) ?? []).map((u) => u.replace(/[.,;:]+$/, '')),
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
  for (const i of context.alert.indicators) known.add(refang(i.value).toLowerCase());
  for (const e of context.enrichment?.enrichments ?? []) {
    known.add(e.normalizedValue.toLowerCase());
    known.add(refang(e.indicator.value).toLowerCase());
  }

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
    confidenceCalibrated:
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
    confidenceCalibrated: 'confidence is outside the 0..1 range',
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
