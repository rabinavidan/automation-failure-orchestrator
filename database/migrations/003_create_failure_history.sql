-- Migration 003: Create failure_history table
-- Tracks aggregate failure history per fingerprint for flaky/recovery detection

CREATE TABLE IF NOT EXISTS failure_history (
  id                  SERIAL PRIMARY KEY,
  fingerprint         VARCHAR(64) NOT NULL UNIQUE,
  test_id             VARCHAR(500) NOT NULL,
  title               VARCHAR(1000),
  suite               VARCHAR(500),
  run_count           INTEGER NOT NULL DEFAULT 0,
  fail_count          INTEGER NOT NULL DEFAULT 0,
  pass_count          INTEGER NOT NULL DEFAULT 0,
  last_statuses       JSONB NOT NULL DEFAULT '[]',
  consecutive_passes  INTEGER NOT NULL DEFAULT 0,
  jira_issue_key      VARCHAR(50),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failure_history_fingerprint ON failure_history(fingerprint);
CREATE INDEX IF NOT EXISTS idx_failure_history_jira_key ON failure_history(jira_issue_key);
CREATE INDEX IF NOT EXISTS idx_failure_history_last_seen ON failure_history(last_seen_at DESC);

-- Trigger to update updated_at automatically
CREATE OR REPLACE FUNCTION update_failure_history_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER failure_history_updated_at
  BEFORE UPDATE ON failure_history
  FOR EACH ROW
  EXECUTE FUNCTION update_failure_history_updated_at();
