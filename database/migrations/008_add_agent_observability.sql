ALTER TABLE agent_executions
  ADD COLUMN IF NOT EXISTS orchestration VARCHAR(32) NOT NULL DEFAULT 'single_agent',
  ADD COLUMN IF NOT EXISTS graph_version VARCHAR(64) NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS agent_model_calls (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_executions(thread_id) ON DELETE CASCADE,
  node VARCHAR(64) NOT NULL,
  prompt_version VARCHAR(64) NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_model_calls_thread ON agent_model_calls (thread_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_model_calls_created ON agent_model_calls (created_at DESC);
