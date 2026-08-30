const OVERCONFIDENT_PHRASES = [
  'definitely',
  'certainly',
  '100%',
  'guaranteed',
  'no doubt',
  'without question',
  'undoubtedly',
  'always',
];

const HEDGE_PHRASES = [
  'might',
  'may',
  'possibly',
  'perhaps',
  'maybe',
  'could be',
  'not sure',
  'unclear whether',
];

const OVERCONFIDENCE_THRESHOLD = 0.85;
const HEDGE_COUNT_THRESHOLD = 3;

export interface LanguageQualityCheck {
  overconfidentLanguage: boolean;
  excessiveHedging: boolean;
}

/**
 * Deterministic, model-free checks on an investigation's written explanation:
 * flags language whose certainty doesn't match the stated confidence
 * (unsupported-sounding absolutes at low confidence) and explanations so
 * hedge-laden they read as evasive even when the model is confident.
 */
export function checkExplanationLanguage(
  explanation: string,
  confidence: number
): LanguageQualityCheck {
  const lower = explanation.toLowerCase();
  const hasOverconfidentPhrase = OVERCONFIDENT_PHRASES.some((phrase) => lower.includes(phrase));
  const hedgeCount = HEDGE_PHRASES.reduce(
    (count, phrase) => count + (lower.includes(phrase) ? 1 : 0),
    0
  );
  return {
    overconfidentLanguage: hasOverconfidentPhrase && confidence < OVERCONFIDENCE_THRESHOLD,
    excessiveHedging: hedgeCount >= HEDGE_COUNT_THRESHOLD,
  };
}
