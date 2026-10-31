/**
 * Retrieval benchmark: Recall@k and MRR of repository search against labeled relevant paths.
 *
 *   npm run benchmark:retrieval
 *
 * Requires a real Ollama embedding model and a repository index built with the same model
 * (POST /api/knowledge/reindex). Search only compares chunks embedded with the active model, so
 * an index built with another model yields zero matches instead of misleading rankings.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { closePool } from '../db/client';
import { meanReciprocalRank, recallAtK } from '../benchmark/metrics';
import { assertRealModel } from '../benchmark/runner';
import {
  getRepositoryKnowledgeStatus,
  searchRepositoryKnowledge,
} from '../services/repository-knowledge';
import { detectModelBackend } from '../services/runtime-capabilities';

const REPO_ROOT = resolve(__dirname, '../../../..');

const RetrievalDatasetSchema = z.object({
  name: z.string(),
  version: z.string(),
  provenance: z.object({ humanValidated: z.boolean() }).passthrough(),
  queries: z
    .array(z.object({ id: z.string(), query: z.string(), relevant: z.array(z.string()).min(1) }))
    .min(1),
});

async function main(): Promise<void> {
  process.env.AI_ENABLED = 'true';
  assertRealModel({ ...(await detectModelBackend()), modelInstalled: null });
  const status = await getRepositoryKnowledgeStatus();
  if (status.activeModelChunkCount === 0) {
    throw new Error(
      `No chunks indexed with embedding model ${status.embeddingModel}; run POST /api/knowledge/reindex first.`
    );
  }
  const dataset = RetrievalDatasetSchema.parse(
    JSON.parse(readFileSync(resolve(REPO_ROOT, 'benchmark/datasets/retrieval-v1.json'), 'utf-8'))
  );
  const rankings: Array<{ id: string; ranked: string[]; relevant: string[] }> = [];
  for (const q of dataset.queries) {
    const matches = await searchRepositoryKnowledge(q.query, 8);
    // Rank distinct documents (several chunks can come from one file).
    const ranked = [...new Set(matches.map((m) => m.sourcePath))];
    rankings.push({ id: q.id, ranked, relevant: q.relevant });
  }
  const result = {
    meta: {
      dataset: `${dataset.name}@${dataset.version}`,
      queries: dataset.queries.length,
      humanValidatedLabels: dataset.provenance.humanValidated,
      embeddingModel: status.embeddingModel,
      indexedChunks: status.activeModelChunkCount,
      generatedAt: new Date().toISOString(),
    },
    metrics: {
      recallAt1: recallAtK(rankings, 1),
      recallAt3: recallAtK(rankings, 3),
      recallAt5: recallAtK(rankings, 5),
      mrr: meanReciprocalRank(rankings),
    },
    rankings,
  };
  const outDir = resolve(
    REPO_ROOT,
    'benchmark/results',
    `retrieval-${result.meta.generatedAt.replace(/[:.]/g, '-')}`
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'retrieval.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result.metrics, null, 2));
  console.log(`Wrote ${outDir}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void closePool().catch(() => undefined));
