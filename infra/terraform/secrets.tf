# Shared secret SIEM/SOAR webhooks must present (x-webhook-secret).
resource "random_password" "webhook" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "webhook" {
  #checkov:skip=CKV2_AWS_57:Rotation must be coordinated with every SIEM sending the header; rotated via runbook, not a Lambda
  name                    = "${local.name}/webhook-secret"
  description             = "x-webhook-secret for SIEM/SOAR webhooks"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "webhook" {
  secret_id     = aws_secretsmanager_secret.webhook.id
  secret_string = random_password.webhook.result
}

# Threat-intel API keys. Terraform creates empty placeholders; operators set real values
# out-of-band (console / CLI), so keys never live in Terraform code or plans.
resource "aws_secretsmanager_secret" "threat_intel" {
  #checkov:skip=CKV2_AWS_57:Third-party API keys are issued and rotated by the providers, not by AWS
  name                    = "${local.name}/threat-intel"
  description             = "AbuseIPDB / VirusTotal / ipinfo API keys for live enrichment"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "threat_intel" {
  secret_id = aws_secretsmanager_secret.threat_intel.id
  secret_string = jsonencode({
    ABUSEIPDB_API_KEY  = ""
    VIRUSTOTAL_API_KEY = ""
    IPINFO_TOKEN       = ""
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
