resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = local.service_namespace
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "internal" {
  for_each = toset(var.deploy_mock_integrations ? ["enrichment", "mock-integrations"] : ["enrichment"])
  name     = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["ingestion", "worker", "enrichment", "mock-integrations"])
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

locals {
  image = { for k, repo in aws_ecr_repository.app : k => "${repo.repository_url}:${var.image_tag}" }

  db_secret = aws_db_instance.main.master_user_secret[0].secret_arn

  # Shared by the API and the worker (same image, different command).
  app_environment = [
    for k, v in {
      NODE_ENV                         = "production"
      PGHOST                           = aws_db_instance.main.address
      PGPORT                           = tostring(aws_db_instance.main.port)
      PGDATABASE                       = aws_db_instance.main.db_name
      DB_SSL                           = "require"
      DB_SSL_CA_FILE                   = local.rds_ca_file
      ENRICHMENT_URL                   = local.enrichment_url
      INTEGRATION_MODE                 = "mock"
      JIRA_BASE_URL                    = var.deploy_mock_integrations ? local.mock_url : ""
      SLACK_WEBHOOK_URL                = var.deploy_mock_integrations ? "${local.mock_url}/slack/services/T00/B00/xxx" : ""
      SOC_ACTIONS_BASE_URL             = var.deploy_mock_integrations ? local.mock_url : ""
      SOC_PROTECTED_HOSTS              = join(",", var.protected_hosts)
      AI_ENABLED                       = tostring(var.ai_enabled)
      MULTI_AGENT_ENABLED              = "true"
      OLLAMA_HOST                      = var.ollama_host
      OLLAMA_MODEL                     = var.ollama_model
      RAG_ENABLED                      = "false"
      INVESTIGATION_QUEUE              = "sqs"
      INVESTIGATION_QUEUE_URL          = aws_sqs_queue.investigations.url
      ALERT_SUPPRESSION_WINDOW_MINUTES = "60"
    } : { name = k, value = v }
  ]

  app_secrets = [
    { name = "PGUSER", valueFrom = "${local.db_secret}:username::" },
    { name = "PGPASSWORD", valueFrom = "${local.db_secret}:password::" },
    { name = "WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.webhook.arn },
  ]

  log_config = { for svc in ["ingestion", "worker", "enrichment", "mock-integrations"] : svc => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.service[svc].name
      awslogs-region        = data.aws_region.current.name
      awslogs-stream-prefix = svc
    }
  } }

  hardened = {
    readonlyRootFilesystem = true
    user                   = "1000"
    linuxParameters        = { initProcessEnabled = true }
  }
}

resource "aws_ecs_task_definition" "ingestion" {
  family                   = "${local.name}-ingestion"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.ingestion.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(local.hardened, {
    name         = "ingestion"
    image        = local.image["ingestion"]
    essential    = true
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]
    environment  = concat(local.app_environment, [{ name = "PORT", value = "3001" }])
    secrets      = local.app_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:3001/health || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = local.log_config["ingestion"]
  })])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(local.hardened, {
    name             = "worker"
    image            = local.image["ingestion"]
    essential        = true
    command          = ["node", "dist/workers/investigation-worker.js"]
    environment      = local.app_environment
    secrets          = local.app_secrets
    stopTimeout      = 60
    logConfiguration = local.log_config["worker"]
  })])
}

resource "aws_ecs_task_definition" "enrichment" {
  family                   = "${local.name}-enrichment"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.no_aws_access.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(local.hardened, {
    name         = "enrichment"
    image        = local.image["enrichment"]
    essential    = true
    user         = "10001"
    portMappings = [{ containerPort = 3003, protocol = "tcp" }]
    environment = [
      { name = "PORT", value = "3003" },
      { name = "ENRICHMENT_MODE", value = var.enrichment_mode },
      { name = "PYTHONDONTWRITEBYTECODE", value = "1" },
    ]
    secrets = [
      { name = "WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.webhook.arn },
      { name = "ABUSEIPDB_API_KEY", valueFrom = "${aws_secretsmanager_secret.threat_intel.arn}:ABUSEIPDB_API_KEY::" },
      { name = "VIRUSTOTAL_API_KEY", valueFrom = "${aws_secretsmanager_secret.threat_intel.arn}:VIRUSTOTAL_API_KEY::" },
      { name = "IPINFO_TOKEN", valueFrom = "${aws_secretsmanager_secret.threat_intel.arn}:IPINFO_TOKEN::" },
    ]
    logConfiguration = local.log_config["enrichment"]
  })])
}

resource "aws_ecs_task_definition" "mock" {
  count                    = var.deploy_mock_integrations ? 1 : 0
  family                   = "${local.name}-mock-integrations"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.no_aws_access.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(local.hardened, {
    name             = "mock-integrations"
    image            = local.image["mock-integrations"]
    essential        = true
    portMappings     = [{ containerPort = 3002, protocol = "tcp" }]
    environment      = [{ name = "MOCK_PORT", value = "3002" }]
    logConfiguration = local.log_config["mock-integrations"]
  })])
}

locals {
  services = merge(
    {
      ingestion  = { task = aws_ecs_task_definition.ingestion.arn, sg = aws_security_group.ingestion.id, count = 1 }
      worker     = { task = aws_ecs_task_definition.worker.arn, sg = aws_security_group.worker.id, count = 1 }
      enrichment = { task = aws_ecs_task_definition.enrichment.arn, sg = aws_security_group.enrichment.id, count = 1 }
    },
    var.deploy_mock_integrations ? {
      mock-integrations = { task = aws_ecs_task_definition.mock[0].arn, sg = aws_security_group.mock.id, count = 1 }
    } : {}
  )
}

resource "aws_ecs_service" "app" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = each.value.task
  desired_count   = each.value.count
  launch_type     = "FARGATE"

  enable_execute_command = false
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [each.value.sg]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = each.key == "ingestion" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.ingestion.arn
      container_name   = "ingestion"
      container_port   = 3001
    }
  }

  dynamic "service_registries" {
    for_each = contains(keys(aws_service_discovery_service.internal), each.key) ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.internal[each.key].arn
    }
  }

  # The deploy workflow rolls out new task definition revisions; Terraform owns the rest.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.http, aws_lb_listener.https]
}
