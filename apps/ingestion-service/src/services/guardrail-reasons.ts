/** Why a code-owned guardrail replaced an agent recommendation (audit log, metrics, spans). */
export const GUARDRAIL_REASONS = [
  'action specialist assessed risk as high',
  'action specialist proposed human_review',
] as const;

export type GuardrailReason = (typeof GUARDRAIL_REASONS)[number];
