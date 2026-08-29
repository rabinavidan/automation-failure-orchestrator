import { z } from 'zod';
import type { AgentInvestigation } from '@orchestrator/shared-types';
import type { InvestigationModel } from './failure-investigation-agent';

const JudgeVerdictSchema = z.object({
  groundedness: z.number().min(0).max(1),
  rootCauseQuality: z.number().min(0).max(1),
  explanationClarity: z.number().min(0).max(1),
  verdict: z.enum(['pass', 'fail']),
  rationale: z.string().min(1),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

const judgeOutputFormat = {
  type: 'object',
  properties: {
    groundedness: { type: 'number', minimum: 0, maximum: 1 },
    rootCauseQuality: { type: 'number', minimum: 0, maximum: 1 },
    explanationClarity: { type: 'number', minimum: 0, maximum: 1 },
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    rationale: { type: 'string' },
  },
  required: ['groundedness', 'rootCauseQuality', 'explanationClarity', 'verdict', 'rationale'],
} as const;

function buildJudgeMessages(investigation: AgentInvestigation) {
  return [
    {
      role: 'system' as const,
      content: [
        'You are a strict quality judge for automated CI-failure investigations.',
        'Score only what is supported by the evidence provided; do not reward confident-sounding but ungrounded claims.',
        'groundedness: does the evidence actually support the suspected root cause?',
        'rootCauseQuality: is the root cause specific and actionable, not vague or generic?',
        'explanationClarity: is the explanation clear, appropriately hedged, and free of unsupported certainty?',
        'verdict must be "fail" if any dimension score is below 0.5, otherwise "pass".',
        'Return only JSON matching the requested schema.',
      ].join(' '),
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        suspectedRootCause: investigation.suspectedRootCause,
        evidence: investigation.evidence,
        explanation: investigation.explanation,
        recommendedAction: investigation.recommendedAction,
        confidence: investigation.confidence,
      }),
    },
  ];
}

export interface JudgeResult {
  ok: boolean;
  verdict?: JudgeVerdict;
  error?: string;
}

export async function judgeInvestigation(
  investigation: AgentInvestigation,
  client: InvestigationModel,
  model: string
): Promise<JudgeResult> {
  try {
    const response = await client.chat({
      model,
      messages: buildJudgeMessages(investigation),
      format: judgeOutputFormat,
      stream: false,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(response.message.content ?? '');
    } catch {
      return { ok: false, error: 'judge output was not valid JSON' };
    }
    const parsed = JudgeVerdictSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'judge output failed schema validation' };
    }
    return { ok: true, verdict: parsed.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'judge call failed' };
  }
}

export interface LabeledJudgeExample {
  id: string;
  investigation: AgentInvestigation;
  humanVerdict: 'pass' | 'fail';
}

export interface JudgeAgreementReport {
  total: number;
  agreed: number;
  agreementRate: number;
  disagreements: Array<{
    id: string;
    humanVerdict: 'pass' | 'fail';
    judgeVerdict: 'pass' | 'fail' | 'unavailable';
  }>;
}

export async function scoreJudgeAgreement(
  examples: LabeledJudgeExample[],
  client: InvestigationModel,
  model: string
): Promise<JudgeAgreementReport> {
  const disagreements: JudgeAgreementReport['disagreements'] = [];
  let agreed = 0;
  for (const example of examples) {
    const result = await judgeInvestigation(example.investigation, client, model);
    const judgeVerdict = result.verdict?.verdict ?? 'unavailable';
    if (judgeVerdict === example.humanVerdict) {
      agreed += 1;
    } else {
      disagreements.push({ id: example.id, humanVerdict: example.humanVerdict, judgeVerdict });
    }
  }
  return {
    total: examples.length,
    agreed,
    agreementRate: examples.length === 0 ? 0 : agreed / examples.length,
    disagreements,
  };
}
