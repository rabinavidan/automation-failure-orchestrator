import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { OllamaEmbedding } from '@llamaindex/ollama';
import { SentenceSplitter } from 'llamaindex';
import { getPool, query } from '../db/client';

const INCLUDED_EXTENSIONS = new Set(['.md', '.ts', '.tsx', '.json', '.sql']);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage']);
const MAX_FILE_BYTES = 150_000;
const MAX_FILES = 160;

export interface TextEmbedder {
  getTextEmbedding(text: string): Promise<number[]>;
}

export interface KnowledgeMatch {
  sourcePath: string;
  chunkIndex: number;
  content: string;
  score: number;
}

function repositoryRoot(): string {
  return resolve(process.env.RAG_SOURCE_ROOT ?? join(__dirname, '../../../../'));
}

function embeddingModel(): string {
  return process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text';
}

function defaultEmbedder(): TextEmbedder {
  return new OllamaEmbedding({
    model: embeddingModel(),
    config: { host: process.env.OLLAMA_HOST ?? 'http://localhost:11434' },
  });
}

function allowedTopLevel(path: string): boolean {
  return (
    path === 'README.md' ||
    path.startsWith(`docs${sep}`) ||
    path.startsWith(`apps${sep}ingestion-service${sep}src${sep}`) ||
    path.startsWith(`packages${sep}`) ||
    path.startsWith(`database${sep}migrations${sep}`)
  );
}

async function discoverFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) break;
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const sourcePath = relative(root, absolute);
      if (entry.isDirectory()) await walk(absolute);
      else if (
        allowedTopLevel(sourcePath) &&
        INCLUDED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))
      ) {
        const fileStat = await stat(absolute);
        if (fileStat.size <= MAX_FILE_BYTES) files.push(absolute);
      }
    }
  }
  await walk(root);
  return files.sort();
}

export async function reindexRepositoryKnowledge(embedder: TextEmbedder = defaultEmbedder()) {
  const root = repositoryRoot();
  const model = embeddingModel();
  const runRows = await query<{ id: string }>(
    `INSERT INTO repository_knowledge_index_runs (status, embedding_model)
     VALUES ('running', $1) RETURNING id`,
    [model]
  );
  const indexRunId = runRows[0].id;
  try {
    const files = await discoverFiles(root);
    const splitter = new SentenceSplitter({ chunkSize: 384, chunkOverlap: 48 });
    const chunks: Array<{
      sourcePath: string;
      chunkIndex: number;
      content: string;
      hash: string;
      embedding: number[];
    }> = [];
    for (const absolute of files) {
      const sourcePath = relative(root, absolute).split(sep).join('/');
      const content = await readFile(absolute, 'utf8');
      const pieces = splitter.splitText(content).filter((piece) => piece.trim().length >= 40);
      for (let chunkIndex = 0; chunkIndex < pieces.length; chunkIndex++) {
        const text = pieces[chunkIndex].trim();
        chunks.push({
          sourcePath,
          chunkIndex,
          content: text,
          hash: createHash('sha256').update(text).digest('hex'),
          embedding: await embedder.getTextEmbedding(text),
        });
      }
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM repository_knowledge_chunks');
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO repository_knowledge_chunks
            (source_path, chunk_index, content, content_hash, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            chunk.sourcePath,
            chunk.chunkIndex,
            chunk.content,
            chunk.hash,
            JSON.stringify(chunk.embedding),
            model,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await query(
      `UPDATE repository_knowledge_index_runs
       SET status = 'completed', file_count = $2, chunk_count = $3, finished_at = NOW()
       WHERE id = $1`,
      [indexRunId, files.length, chunks.length]
    );
    return {
      indexRunId,
      fileCount: files.length,
      chunkCount: chunks.length,
      embeddingModel: model,
    };
  } catch (error) {
    await query(
      `UPDATE repository_knowledge_index_runs
       SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
      [indexRunId, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

export async function searchRepositoryKnowledge(
  searchText: string,
  topK = 4,
  embedder: TextEmbedder = defaultEmbedder()
): Promise<KnowledgeMatch[]> {
  const queryEmbedding = await embedder.getTextEmbedding(searchText);
  const rows = await query<{
    source_path: string;
    chunk_index: number;
    content: string;
    embedding: number[];
  }>('SELECT source_path, chunk_index, content, embedding FROM repository_knowledge_chunks');
  return rows
    .map((row) => ({
      sourcePath: row.source_path,
      chunkIndex: row.chunk_index,
      content: row.content,
      score: cosineSimilarity(queryEmbedding, row.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(Math.max(topK, 1), 8));
}

export async function getRepositoryKnowledgeStatus() {
  const counts = await query<{ chunk_count: string; source_count: string }>(
    `SELECT COUNT(*) AS chunk_count, COUNT(DISTINCT source_path) AS source_count
     FROM repository_knowledge_chunks`
  );
  const latest = await query(
    `SELECT status, embedding_model, file_count, chunk_count, error, started_at, finished_at
     FROM repository_knowledge_index_runs ORDER BY id DESC LIMIT 1`
  );
  return {
    chunkCount: Number.parseInt(counts[0]?.chunk_count ?? '0', 10),
    sourceCount: Number.parseInt(counts[0]?.source_count ?? '0', 10),
    latestRun: latest[0] ?? null,
  };
}
