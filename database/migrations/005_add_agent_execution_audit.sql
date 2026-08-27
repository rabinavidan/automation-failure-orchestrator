-- Human-readable audit records complement LangGraph's internal checkpoint tables.

CREATE TABLE IF NOT EXISTS agent_executions (
  thread_id TEXT PRIMARY KEY,
  run_id VARCHAR(255) NOT NULL REFERENCES test_runs(run_id) ON DELETE CASCADE,
  fingerprint VARCHAR(64) NOT NULL,
  test_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  final_result JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_executions_fingerprint_started
  ON agent_executions (fingerprint, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_execution_events (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_executions(thread_id) ON DELETE CASCADE,
  node VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_execution_events_thread
  ON agent_execution_events (thread_id, id);
