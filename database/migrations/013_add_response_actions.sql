-- Migration 013: Response playbook actions with human approval and rollback (SOC track M5)

CREATE TABLE IF NOT EXISTS response_actions (
  id                 BIGSERIAL PRIMARY KEY,
  alert_id           TEXT NOT NULL REFERENCES security_alerts(alert_id) ON DELETE CASCADE,
  playbook_id        VARCHAR(64) NOT NULL,
  playbook_version   INTEGER NOT NULL,
  step_id            VARCHAR(64) NOT NULL,
  action             VARCHAR(32) NOT NULL,
  description        TEXT NOT NULL,
  target_type        VARCHAR(16),
  target_value       TEXT NOT NULL DEFAULT '',
  approval_required  BOOLEAN NOT NULL,
  status             VARCHAR(24) NOT NULL,
  detail             TEXT,
  reviewer           TEXT,
  review_comment     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at         TIMESTAMPTZ,
  executed_at        TIMESTAMPTZ,
  rolled_back_by     TEXT,
  rolled_back_at     TIMESTAMPTZ,
  -- Idempotency: one action per alert, playbook step and target.
  UNIQUE (alert_id, playbook_id, step_id, target_value)
);

CREATE INDEX IF NOT EXISTS idx_response_actions_status_created
  ON response_actions (status, created_at DESC);

-- Append-only audit trail: who planned, approved, rejected, executed or rolled back what.
CREATE TABLE IF NOT EXISTS response_action_events (
  id          BIGSERIAL PRIMARY KEY,
  action_id   BIGINT NOT NULL REFERENCES response_actions(id) ON DELETE CASCADE,
  event       VARCHAR(32) NOT NULL,
  actor       TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_response_action_events_action
  ON response_action_events (action_id, id);
