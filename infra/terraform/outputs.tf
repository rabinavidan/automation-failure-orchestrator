locals {
  base_url = var.certificate_arn != "" ? "https://${aws_lb.main.dns_name}" : "http://${aws_lb.main.dns_name}"
}

output "api_base_url" {
  description = "Public API base URL (point a DNS record at it for your certificate's hostname)."
  value       = local.base_url
}

output "siem_webhook_urls" {
  description = "Webhook URLs to configure in each SIEM (send the x-webhook-secret header)."
  value = {
    splunk   = "${local.base_url}/api/alerts/splunk"
    sentinel = "${local.base_url}/api/alerts/sentinel"
    wazuh    = "${local.base_url}/api/alerts/wazuh"
  }
}

output "webhook_secret_arn" {
  description = "Secrets Manager ARN holding the x-webhook-secret value."
  value       = aws_secretsmanager_secret.webhook.arn
}

output "threat_intel_secret_arn" {
  description = "Secrets Manager ARN for live threat-intel API keys."
  value       = aws_secretsmanager_secret.threat_intel.arn
}

output "ecr_repositories" {
  description = "ECR repository URLs per image."
  value       = { for k, repo in aws_ecr_repository.app : k => repo.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "investigation_queue_url" {
  value = aws_sqs_queue.investigations.url
}

output "investigation_dlq_url" {
  value = aws_sqs_queue.investigations_dlq.url
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub environment."
  value       = aws_iam_role.deploy.arn
}
