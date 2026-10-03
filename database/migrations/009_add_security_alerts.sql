-- Migration 009: Security alert ingestion (SOC automation track)
-- security_alerts: one row per delivered alert (alert_id is the idempotency key)
-- alert_fingerprints: aggregate per logical detection for dedup/suppression

CREATE TABLE IF NOT EXISTS alert_fingerprints (
  id                SERIAL PRIMARY KEY,
  fingerprint       VARCHAR(64) NOT NULL UNIQUE,
  vendor            VARCHAR(32) NOT NULL,
  rule_id           TEXT NOT NULL,
  rule_name         TEXT NOT NULL,
  host              TEXT,
  user_name         TEXT,
  max_severity      VARCHAR(16) NOT NULL,
  occurrence_count  INTEGER NOT NULL DEFAULT 0,
  suppressed_count  INTEGER NOT NULL DEFAULT 0,
  last_alert_id     TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_fingerprints_last_seen
  ON alert_fingerprints (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS security_alerts (
  id            BIGSERIAL PRIMARY KEY,
  alert_id      TEXT NOT NULL UNIQUE,
  fingerprint   VARCHAR(64) NOT NULL REFERENCES alert_fingerprints(fingerprint),
  vendor        VARCHAR(32) NOT NULL,
  rule_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  severity      VARCHAR(16) NOT NULL,
  status        VARCHAR(32) NOT NULL,
  host          TEXT,
  user_name     TEXT,
  indicators    JSONB NOT NULL DEFAULT '[]',
  mitre         JSONB,
  alert         JSONB NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_alerts_fingerprint
  ON security_alerts (fingerprint, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_alerts_status_received
  ON security_alerts (status, received_at DESC);
