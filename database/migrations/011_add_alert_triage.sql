-- Migration 011: Deterministic SOC triage results (SOC track M3)

ALTER TABLE security_alerts
  ADD COLUMN IF NOT EXISTS triage_disposition VARCHAR(32),
  ADD COLUMN IF NOT EXISTS triage_priority VARCHAR(4),
  ADD COLUMN IF NOT EXISTS risk_score SMALLINT,
  ADD COLUMN IF NOT EXISTS triage JSONB,
  ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMPTZ;

-- Analyst queue: open work ordered by priority, then risk.
CREATE INDEX IF NOT EXISTS idx_security_alerts_triage_queue
  ON security_alerts (triage_disposition, triage_priority, risk_score DESC, received_at DESC);
