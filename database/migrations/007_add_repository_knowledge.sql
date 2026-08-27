CREATE TABLE IF NOT EXISTS repository_knowledge_chunks (
  id BIGSERIAL PRIMARY KEY,
  source_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  embedding JSONB NOT NULL,
  embedding_model TEXT NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_repository_knowledge_source
  ON repository_knowledge_chunks (source_path);

CREATE TABLE IF NOT EXISTS repository_knowledge_index_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  embedding_model TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
