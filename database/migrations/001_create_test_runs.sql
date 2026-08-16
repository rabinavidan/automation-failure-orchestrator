-- Migration 001: Create test_runs table
-- Stores one record per test suite run (webhook payload)

CREATE TABLE IF NOT EXISTS test_runs (
  id            SERIAL PRIMARY KEY,
  run_id        VARCHAR(255) NOT NULL UNIQUE,
  repository    VARCHAR(500) NOT NULL,
  branch        VARCHAR(255) NOT NULL,
  commit_sha    VARCHAR(40) NOT NULL,
  environment   VARCHAR(100) NOT NULL,
  triggered_by  VARCHAR(255) NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ NOT NULL,
  report_url    TEXT,
  schema_version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  summary       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_runs_run_id ON test_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_branch ON test_runs(branch);
CREATE INDEX IF NOT EXISTS idx_test_runs_created_at ON test_runs(created_at DESC);
