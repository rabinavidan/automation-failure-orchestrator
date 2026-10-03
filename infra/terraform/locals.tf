locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  public_subnets  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnets = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  service_namespace = "soc.internal"
  enrichment_url    = "http://enrichment.${local.service_namespace}:3003"
  mock_url          = "http://mock-integrations.${local.service_namespace}:3002"

  # RDS CA bundle baked into the ingestion image (see apps/ingestion-service/Dockerfile).
  rds_ca_file = "/etc/ssl/certs/rds-global-bundle.pem"
}
