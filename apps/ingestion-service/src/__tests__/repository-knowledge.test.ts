import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankKnowledgeChunks } from '../services/repository-knowledge';

describe('repository knowledge retrieval', () => {
  it('ranks identical vectors above unrelated vectors', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it('rejects incompatible and empty embeddings', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it('ranks chunks by similarity and clamps topK', () => {
    const rows = [
      { source_path: 'a.md', chunk_index: 0, content: 'a', embedding: [1, 0] },
      { source_path: 'b.md', chunk_index: 0, content: 'b', embedding: [0, 1] },
      { source_path: 'c.md', chunk_index: 0, content: 'c', embedding: [0.9, 0.1] },
    ];
    expect(rankKnowledgeChunks([1, 0], rows, 2).map((m) => m.sourcePath)).toEqual(['a.md', 'c.md']);
    expect(rankKnowledgeChunks([1, 0], rows, 0)).toHaveLength(1);
  });
});
