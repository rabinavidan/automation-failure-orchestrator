import type { AgentInvestigation } from '@orchestrator/shared-types';

export interface AgentEvaluationResult {
  passed: boolean;
  score: number;
  metrics: {
    schemaComplete: boolean;
    specialistCoverage: boolean;
    repositoryGrounded: boolean;
    safeHighRiskPolicy: boolean;
    confidenceCalibrated: boolean;
  };
  failures: string[];
}

export function evaluateAgentInvestigation(
  investigation: AgentInvestigation,
  options: { ragExpected?: boolean; multiAgentExpected?: boolean } = {}
): AgentEvaluationResult {
  const reports = investigation.specialistReports ?? [];
  const actionReport = reports.find((report) => report.agent === 'action');
  const metrics = {
    schemaComplete: Boolean(
      investigation.suspectedRootCause.trim() &&
      investigation.explanation.trim() &&
      investigation.evidence.length > 0 &&
      investigation.model.trim()
    ),
    specialistCoverage:
      !options.multiAgentExpected ||
      ['triage', 'repository', 'action'].every((agent) =>
        reports.some((report) => report.agent === agent)
      ),
    repositoryGrounded:
      !options.ragExpected ||
      (investigation.toolsUsed.includes('search_repository_context') &&
        (investigation.sources?.length ?? 0) > 0),
    safeHighRiskPolicy:
      actionReport?.risk !== 'high' || investigation.recommendedAction === 'human_review',
    confidenceCalibrated:
      investigation.confidence >= 0 &&
      investigation.confidence <= 1 &&
      reports.every((report) => report.confidence >= 0 && report.confidence <= 1),
  };
  const labels: Record<keyof typeof metrics, string> = {
    schemaComplete: 'required investigation fields are incomplete',
    specialistCoverage: 'required specialist reports are missing',
    repositoryGrounded: 'RAG investigation has no repository tool evidence or citations',
    safeHighRiskPolicy: 'high-risk action bypassed human review',
    confidenceCalibrated: 'confidence is outside the 0..1 range',
  };
  const failures = (Object.keys(metrics) as Array<keyof typeof metrics>)
    .filter((key) => !metrics[key])
    .map((key) => labels[key]);
  const score = Object.values(metrics).filter(Boolean).length / Object.keys(metrics).length;
  return { passed: failures.length === 0, score, metrics, failures };
}
