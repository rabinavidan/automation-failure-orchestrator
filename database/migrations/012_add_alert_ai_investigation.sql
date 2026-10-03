-- Migration 012: Advisory SOC multi-agent investigations (SOC track M4)
-- SOC investigations reuse the agent audit/telemetry tables, so the observability
-- summary covers both tracks. An execution belongs to either a CI run or an alert.

ALTER TABLE agent_executions
  ALTER COLUMN run_id DROP NOT NULL,
  ALTER COLUMN test_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS alert_id TEXT REFERENCES security_alerts(alert_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS subject VARCHAR(16) NOT NULL DEFAULT 'ci_failure';

ALTER TABLE agent_executions
  ADD CONSTRAINT agent_executions_subject_ck CHECK (run_id IS NOT NULL OR alert_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_agent_executions_alert ON agent_executions (alert_id)
  WHERE alert_id IS NOT NULL;

ALTER TABLE security_alerts
  ADD COLUMN IF NOT EXISTS ai_investigation_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS ai_investigation JSONB,
  ADD COLUMN IF NOT EXISTS ai_evaluation JSONB,
  ADD COLUMN IF NOT EXISTS ai_investigated_at TIMESTAMPTZ;
