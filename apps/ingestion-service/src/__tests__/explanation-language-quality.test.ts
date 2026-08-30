import { describe, expect, it } from 'vitest';
import { checkExplanationLanguage } from '../services/explanation-language-quality';

describe('checkExplanationLanguage', () => {
  it('flags overconfident language at low confidence', () => {
    const result = checkExplanationLanguage(
      'This is definitely a database connection pool exhaustion bug.',
      0.6
    );
    expect(result.overconfidentLanguage).toBe(true);
  });

  it('does not flag overconfident language when confidence is high enough to back it up', () => {
    const result = checkExplanationLanguage(
      'This is definitely a database connection pool exhaustion bug.',
      0.9
    );
    expect(result.overconfidentLanguage).toBe(false);
  });

  it('does not flag explanations with no absolute-certainty phrases', () => {
    const result = checkExplanationLanguage(
      'The evidence points to a transient dependency failure.',
      0.5
    );
    expect(result.overconfidentLanguage).toBe(false);
  });

  it('flags excessive hedging when several hedge phrases appear', () => {
    const result = checkExplanationLanguage(
      'It might be a timeout, or maybe a config issue, possibly related to retries, though it could be something else entirely.',
      0.7
    );
    expect(result.excessiveHedging).toBe(true);
  });

  it('does not flag a single, appropriately hedged claim', () => {
    const result = checkExplanationLanguage(
      'This might be a transient dependency issue given the intermittent history.',
      0.7
    );
    expect(result.excessiveHedging).toBe(false);
  });

  it('is case-insensitive', () => {
    const result = checkExplanationLanguage('This is DEFINITELY the root cause.', 0.5);
    expect(result.overconfidentLanguage).toBe(true);
  });
});
