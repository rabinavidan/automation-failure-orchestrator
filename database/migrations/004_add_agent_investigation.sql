-- Persist structured Agentic AI investigations for auditability and UI access.

ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS agent_investigation JSONB;

CREATE INDEX IF NOT EXISTS idx_test_results_agent_investigation
  ON test_results USING GIN (agent_investigation)
  WHERE agent_investigation IS NOT NULL;
