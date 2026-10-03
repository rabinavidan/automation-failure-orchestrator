# Each tier only accepts traffic from the tier in front of it.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public webhook endpoint, restricted to SIEM/SOAR egress ranges"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = var.certificate_arn != "" ? toset(var.allowed_ingress_cidrs) : toset([])
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from allowed SIEM/SOAR range"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from allowed range (redirected to HTTPS unless allow_insecure_http)"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ingestion" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to ingestion tasks"
  referenced_security_group_id = aws_security_group.ingestion.id
  from_port                    = 3001
  to_port                      = 3001
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "ingestion" {
  name        = "${local.name}-ingestion"
  description = "Ingestion API tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "ingestion_from_alb" {
  security_group_id            = aws_security_group.ingestion.id
  description                  = "API traffic from the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3001
  to_port                      = 3001
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Investigation worker tasks (no inbound traffic)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "enrichment" {
  name        = "${local.name}-enrichment"
  description = "Threat-intel enrichment tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "enrichment_from_ingestion" {
  security_group_id            = aws_security_group.enrichment.id
  description                  = "Enrichment requests from ingestion"
  referenced_security_group_id = aws_security_group.ingestion.id
  from_port                    = 3003
  to_port                      = 3003
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "mock" {
  name        = "${local.name}-mock-integrations"
  description = "Mock Jira/Slack/EDR/firewall (demo)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "mock_from_app" {
  for_each = {
    ingestion = aws_security_group.ingestion.id
    worker    = aws_security_group.worker.id
  }
  security_group_id            = aws_security_group.mock.id
  description                  = "Integration calls from ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 3002
  to_port                      = 3002
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL, reachable only from application tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  for_each = {
    ingestion = aws_security_group.ingestion.id
    worker    = aws_security_group.worker.id
  }
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# Application tasks need outbound HTTPS through the NAT gateway for ECR image pulls,
# Secrets Manager, SQS, CloudWatch and external threat-intel APIs (AbuseIPDB,
# VirusTotal, ipinfo), whose IPs are not stable enough to enumerate.
resource "aws_vpc_security_group_egress_rule" "app_egress" {
  for_each = {
    ingestion  = aws_security_group.ingestion.id
    worker     = aws_security_group.worker.id
    enrichment = aws_security_group.enrichment.id
    mock       = aws_security_group.mock.id
  }
  security_group_id = each.value
  description       = "Outbound HTTPS/HTTP and intra-VPC service calls for ${each.key}"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
