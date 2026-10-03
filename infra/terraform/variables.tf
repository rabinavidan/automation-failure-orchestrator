variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "soc-orchestrator"
}

variable "environment" {
  description = "Deployment environment name (e.g. demo, staging, prod)."
  type        = string
  default     = "demo"
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "eu-central-1"
}

variable "vpc_cidr" {
  description = "VPC CIDR block (two public and two private /20 subnets are carved from it)."
  type        = string
  default     = "10.40.0.0/16"
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the public webhook endpoint (your SIEM / SOAR egress IPs)."
  type        = list(string)

  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && !contains(var.allowed_ingress_cidrs, "0.0.0.0/0")
    error_message = "Restrict ingress to your SIEM/SOAR egress ranges; 0.0.0.0/0 is not allowed."
  }
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the HTTPS listener. Required unless allow_insecure_http is true."
  type        = string
  default     = ""
}

variable "allow_insecure_http" {
  description = "Serve plain HTTP when no certificate is available. Demo only: the webhook secret travels in a header."
  type        = bool
  default     = false

  validation {
    condition     = var.allow_insecure_http || var.certificate_arn != ""
    error_message = "Provide certificate_arn, or explicitly set allow_insecure_http = true for a throwaway demo."
  }
}

variable "image_tag" {
  description = "Initial container image tag. Later deploys are rolled out by the deploy workflow."
  type        = string
  default     = "bootstrap"
}

variable "ai_enabled" {
  description = "Enable advisory SOC agents. Requires a reachable Ollama endpoint (ollama_host)."
  type        = bool
  default     = false
}

variable "ollama_host" {
  description = "Ollama endpoint reachable from the VPC (e.g. a GPU instance), used when ai_enabled is true."
  type        = string
  default     = ""
}

variable "ollama_model" {
  description = "Model used by the advisory agents."
  type        = string
  default     = "qwen3:4b"
}

variable "enrichment_mode" {
  description = "Threat-intel enrichment mode: mock (offline intel) or live (real APIs; set keys in the secret)."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "live"], var.enrichment_mode)
    error_message = "enrichment_mode must be mock or live."
  }
}

variable "deploy_mock_integrations" {
  description = "Run the mock Jira/Slack/EDR/firewall service (demo). Disable when wiring real integrations."
  type        = bool
  default     = true
}

variable "protected_hosts" {
  description = "Hosts that response playbooks may never isolate (e.g. domain controllers)."
  type        = list(string)
  default     = ["dc-01", "dc-02"]
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "Run RDS Multi-AZ (recommended for production)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the database and load balancer from accidental deletion. Disable before `terraform destroy`."
  type        = bool
  default     = true
}

variable "waf_rate_limit_per_5m" {
  description = "Max requests per source IP per 5 minutes before WAF blocks (SIEM bursts included)."
  type        = number
  default     = 2000
}

variable "log_retention_days" {
  description = "CloudWatch log retention for services, WAF and VPC flow logs (security logs: keep >= 1 year)."
  type        = number
  default     = 365
}

variable "alarm_email" {
  description = "Optional email subscribed to operational alarms (DLQ depth, unhealthy targets)."
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to deploy via OIDC."
  type        = string
  default     = "rabinavidan/automation-failure-orchestrator"
}

variable "github_environment" {
  description = "GitHub Actions environment whose jobs may assume the deploy role."
  type        = string
  default     = "production"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC identity provider (only one may exist per account)."
  type        = bool
  default     = true
}
