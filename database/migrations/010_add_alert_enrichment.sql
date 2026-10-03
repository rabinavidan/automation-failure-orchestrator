-- Migration 010: Threat-intel enrichment results for security alerts (SOC track M2)
-- Written by the ingestion service after the Python enrichment service responds.

ALTER TABLE security_alerts
  ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS enrichment_verdict VARCHAR(16),
  ADD COLUMN IF NOT EXISTS enrichment JSONB,
  ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_security_alerts_enrichment_verdict
  ON security_alerts (enrichment_verdict, received_at DESC)
  WHERE enrichment_verdict IS NOT NULL;
