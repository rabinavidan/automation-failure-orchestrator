import type { AgentInvestigation } from '@orchestrator/shared-types';
import { evaluateAgentInvestigation, type AgentEvaluationResult } from './agent-evaluation';
import { judgeInvestigation, type JudgeResult } from './agent-judge';
import { checkExplanationLanguage } from './explanation-language-quality';
import type { InvestigationModel } from './failure-investigation-agent';

export type FailureMode =
  | 'schema_incomplete'
  | 'missing_specialist_coverage'
  | 'ungrounded_rag'
  | 'unsafe_high_risk_policy'
  | 'confidence_out_of_range'
  | 'low_groundedness'
  | 'low_root_cause_quality'
  | 'low_explanation_clarity'
  | 'judge_unavailable'
  | 'overconfident_language'
  | 'excessive_hedging';

const FAILURE_MODES: FailureMode[] = [
  'schema_incomplete',
  'missing_specialist_coverage',
  'ungrounded_rag',
  'unsafe_high_risk_policy',
  'confidence_out_of_range',
  'low_groundedness',
  'low_root_cause_quality',
  'low_explanation_clarity',
  'judge_unavailable',
  'overconfident_language',
  'excessive_hedging',
];

const QUALITY_THRESHOLD = 0.5;

export function classifyFailureModes(
  investigation: Pick<AgentInvestigation, 'explanation' | 'confidence'>,
  deterministic: AgentEvaluationResult,
  judge?: JudgeResult
): FailureMode[] {
  const modes: FailureMode[] = [];
  if (!deterministic.metrics.schemaComplete) modes.push('schema_incomplete');
  if (!deterministic.metrics.specialistCoverage) modes.push('missing_specialist_coverage');
  if (!deterministic.metrics.repositoryGrounded) modes.push('ungrounded_rag');
  if (!deterministic.metrics.safeHighRiskPolicy) modes.push('unsafe_high_risk_policy');
  if (!deterministic.metrics.confidenceCalibrated) modes.push('confidence_out_of_range');
  const language = checkExplanationLanguage(investigation.explanation, investigation.confidence);
  if (language.overconfidentLanguage) modes.push('overconfident_language');
  if (language.excessiveHedging) modes.push('excessive_hedging');
  if (judge) {
    if (!judge.ok) {
      modes.push('judge_unavailable');
    } else if (judge.verdict) {
      if (judge.verdict.groundedness < QUALITY_THRESHOLD) modes.push('low_groundedness');
      if (judge.verdict.rootCauseQuality < QUALITY_THRESHOLD) modes.push('low_root_cause_quality');
      if (judge.verdict.explanationClarity < QUALITY_THRESHOLD)
        modes.push('low_explanation_clarity');
    }
  }
  return modes;
}

export interface FailureModeSample {
  threadId: string;
  testId: string;
  fingerprint: string;
  modes: FailureMode[];
}

export interface FailureModeReport {
  sampleSize: number;
  cleanCount: number;
  modeCounts: Record<FailureMode, number>;
  examples: Record<FailureMode, string[]>;
}

export function buildFailureModeReport(
  samples: FailureModeSample[],
  exampleLimit = 3
): FailureModeReport {
  const modeCounts = Object.fromEntries(FAILURE_MODES.map((mode) => [mode, 0])) as Record<
    FailureMode,
    number
  >;
  const examples = Object.fromEntries(
    FAILURE_MODES.map((mode) => [mode, [] as string[]])
  ) as Record<FailureMode, string[]>;
  let cleanCount = 0;
  for (const sample of samples) {
    if (sample.modes.length === 0) {
      cleanCount += 1;
      continue;
    }
    for (const mode of sample.modes) {
      modeCounts[mode] += 1;
      if (examples[mode].length < exampleLimit) {
        examples[mode].push(sample.threadId);
      }
    }
  }
  return { sampleSize: samples.length, cleanCount, modeCounts, examples };
}

export interface ExecutionRecord {
  threadId: string;
  runId: string;
  fingerprint: string;
  testId: string;
  model: string;
  finalResult: AgentInvestigation;
}

export interface ExecutionFetcher {
  fetchRecentCompleted(limit: number): Promise<ExecutionRecord[]>;
}

export interface SampleFailureModesOptions {
  limit?: number;
  ragExpected?: boolean;
  multiAgentExpected?: boolean;
  judgeClient?: InvestigationModel;
  judgeModel?: string;
  exampleLimit?: number;
}

export async function sampleProductionFailureModes(
  fetcher: ExecutionFetcher,
  options: SampleFailureModesOptions = {}
): Promise<FailureModeReport> {
  const records = await fetcher.fetchRecentCompleted(options.limit ?? 50);
  const samples: FailureModeSample[] = [];
  for (const record of records) {
    const deterministic = evaluateAgentInvestigation(record.finalResult, {
      ragExpected: options.ragExpected,
      multiAgentExpected: options.multiAgentExpected,
    });
    const judge = options.judgeClient
      ? await judgeInvestigation(
          record.finalResult,
          options.judgeClient,
          options.judgeModel ?? record.model
        )
      : undefined;
    samples.push({
      threadId: record.threadId,
      testId: record.testId,
      fingerprint: record.fingerprint,
      modes: classifyFailureModes(record.finalResult, deterministic, judge),
    });
  }
  return buildFailureModeReport(samples, options.exampleLimit);
}
