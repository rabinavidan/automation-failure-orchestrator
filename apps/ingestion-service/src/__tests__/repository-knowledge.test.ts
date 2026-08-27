import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../services/repository-knowledge';

describe('repository knowledge retrieval', () => {
  it('ranks identical vectors above unrelated vectors', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it('rejects incompatible and empty embeddings', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });
});
