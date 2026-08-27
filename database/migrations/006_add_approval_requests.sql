CREATE TABLE IF NOT EXISTS approval_requests (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(thread_id) ON DELETE CASCADE,
  run_id VARCHAR(255) NOT NULL REFERENCES test_runs(run_id) ON DELETE CASCADE,
  fingerprint VARCHAR(64) NOT NULL,
  test_id TEXT NOT NULL,
  classification VARCHAR(64) NOT NULL,
  requested_action VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  context JSONB NOT NULL,
  investigation JSONB NOT NULL,
  reviewer TEXT,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status_created
  ON approval_requests (status, created_at DESC);
