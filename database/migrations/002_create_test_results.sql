-- Migration 002: Create test_results table
-- Stores individual test outcomes linked to a run

CREATE TABLE IF NOT EXISTS test_results (
  id              SERIAL PRIMARY KEY,
  run_id          VARCHAR(255) NOT NULL REFERENCES test_runs(run_id) ON DELETE CASCADE,
  test_id         VARCHAR(500) NOT NULL,
  title           VARCHAR(1000) NOT NULL,
  suite           VARCHAR(500) NOT NULL,
  file            VARCHAR(500) NOT NULL,
  owner           VARCHAR(255),
  status          VARCHAR(20) NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  duration_ms     INTEGER NOT NULL,
  retry           INTEGER NOT NULL DEFAULT 0,
  fingerprint     VARCHAR(64),
  classification  VARCHAR(50),
  error_name      TEXT,
  error_message   TEXT,
  error_stack     TEXT,
  metadata        JSONB,
  artifacts       JSONB,
  jira_issue_key  VARCHAR(50),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results(run_id);
CREATE INDEX IF NOT EXISTS idx_test_results_fingerprint ON test_results(fingerprint);
CREATE INDEX IF NOT EXISTS idx_test_results_status ON test_results(status);
CREATE INDEX IF NOT EXISTS idx_test_results_classification ON test_results(classification);
CREATE INDEX IF NOT EXISTS idx_test_results_created_at ON test_results(created_at DESC);
