# AWS deployment (Terraform)

Production-shaped deployment of the SOC automation platform on AWS: ECS Fargate,
RDS PostgreSQL, SQS, Secrets Manager, KMS, WAF, and keyless GitHub Actions deploys.

```text
SIEMs (Splunk / Sentinel / Wazuh)
        │  HTTPS + x-webhook-secret, from allowed CIDRs only
        ▼
   AWS WAF (rate limit, IP reputation, known bad inputs incl. Log4j, anonymizers)
        ▼
   Application Load Balancer (public subnets, access logs → S3)
        ▼                                    private subnets (no public IPs)
   ┌──────────────┐  enqueue alert id  ┌─────────────┐  DLQ after 3 failures
   │ ingestion    │ ─────────────────► │ SQS (KMS)   │ ──────────► alarm → SNS
   │ (API, triage,│                    └──────┬──────┘
   │  playbooks)  │                           ▼
   └──┬───────┬───┘                    ┌──────────────┐
      │       │ Cloud Map DNS          │ investigation│ advisory SOC agents
      │       ▼                        │ worker       │ (Ollama via ollama_host)
      │  ┌───────────┐  ┌───────────┐  └──────┬───────┘
      │  │enrichment │  │ mock Jira/│         │
      │  │ (Python)  │  │ Slack/EDR │◄────────┘
      │  └───────────┘  └───────────┘
      ▼
   RDS PostgreSQL 16 (KMS, TLS forced, managed password in Secrets Manager)
```

## Security controls

| Area             | Control                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge             | WAF: per-IP rate limit, AWS IP reputation, known bad inputs (Log4j), anonymous IPs (hosting providers counted, not blocked, so cloud SIEMs work)                              |
| Ingress          | ALB security group accepts only `allowed_ingress_cidrs` (0.0.0.0/0 rejected by validation)                                                                                    |
| Transport        | HTTPS required (TLS 1.3 policy) unless `allow_insecure_http` is explicitly set for a throwaway demo; RDS `rds.force_ssl=1`, app verifies the RDS CA                           |
| Network          | Tasks in private subnets without public IPs; each tier only reachable from the tier in front; default SG locked; VPC flow logs                                                |
| Identity         | Least-privilege task roles (API: `SendMessage` only; worker: consume only; enrichment/mock: no AWS access); GitHub OIDC deploy role scoped to one repo + environment          |
| Secrets          | RDS-managed master password, webhook secret and threat-intel keys in Secrets Manager (KMS); injected at runtime, never in plans or images; WAF logs redact `x-webhook-secret` |
| Encryption       | One customer-managed KMS key (rotation on) for RDS, SQS, SNS, Secrets Manager, CloudWatch Logs, ECR                                                                           |
| Supply chain     | Immutable ECR tags, scan on push; images also Trivy-scanned in CI                                                                                                             |
| Containers       | Read-only root filesystem, non-root user, init process                                                                                                                        |
| Resilience       | ECS deployment circuit breaker with rollback; SQS redrive to DLQ; RDS backups (7 days), deletion protection, final snapshot                                                   |
| Audit            | ALB access logs (S3, TLS-only bucket policy), WAF logs, flow logs, service logs (1 year)                                                                                      |
| IaC quality gate | CI runs `terraform fmt/validate` and **Checkov** (fails on any unskipped finding; 13 skips documented inline with reasons)                                                    |

## Zero-cost demo (no AWS account)

You do not need to apply this Terraform to demonstrate the AWS design. The same
containers and code paths run locally against [moto](https://github.com/getmoto/moto), an
open-source AWS emulator:

```bash
docker compose -f docker-compose.yml -f docker-compose.aws-local.yml up --build -d
npm run demo:aws-local
```

This starts the SQS investigation queue + dead-letter queue (same settings as `sqs.tf`), the
separate **investigation worker** (the container ECS would run), and a deterministic
Ollama-protocol stub so the advisory agents run without a GPU or paid model. The demo ingests
an alert, shows the API enqueueing to SQS, the worker consuming it, the persisted
investigation, and an empty queue afterwards. CI runs this exact flow on every PR
(`Zero-cost AWS demo` job), and runs `terraform validate` + Checkov on this directory, so the
infrastructure is verified without ever being applied or billed.

| Cloud component    | Zero-cost stand-in                                     |
| ------------------ | ------------------------------------------------------ |
| SQS + DLQ          | moto (open source, local)                              |
| ECS worker service | `investigation-worker` container (same image/cmd)      |
| RDS PostgreSQL     | local PostgreSQL 16 container                          |
| LLM (GPU instance) | `scripts/ollama-demo-stub.mjs`, or real Ollama locally |
| ALB / WAF / KMS    | not emulated: validated + Checkov-scanned in CI        |

## Deploy (billable, optional)

```bash
cd infra/terraform
cp backend.hcl.example backend.hcl        # S3 state bucket
cp demo.tfvars.example demo.tfvars        # set allowed_ingress_cidrs (+ certificate_arn)
terraform init -backend-config=backend.hcl
terraform plan  -var-file=demo.tfvars -out=tfplan
terraform apply tfplan
```

Then, in GitHub → Settings → Environments → `production`: add required reviewers and the
variables `AWS_DEPLOY_ROLE_ARN` (output `github_deploy_role_arn`), `AWS_REGION`, `NAME_PREFIX`
(`<project>-<environment>`). Run **Deploy to AWS** (`.github/workflows/deploy-aws.yml`) to build,
push and roll the services. Configure each SIEM with the `siem_webhook_urls` output and the
secret from `webhook_secret_arn`.

Live threat intel: put real keys into the `threat_intel_secret_arn` secret and set
`enrichment_mode = "live"`. Advisory agents: point `ollama_host` at a GPU instance in the VPC and
set `ai_enabled = true`.

## Cost (eu-central-1, demo sizing, approximate)

| Item                                      | ~USD / month |
| ----------------------------------------- | -----------: |
| NAT gateway (single)                      |           35 |
| ALB                                       |           20 |
| WAF (web ACL + 5 rules + requests)        |           11 |
| Fargate (4 small tasks, 24/7)             |           40 |
| RDS db.t4g.micro + 20 GB gp3              |           15 |
| KMS, Secrets Manager, CloudWatch, SQS, S3 |            8 |
| **Total**                                 |     **~130** |

Tear down when not demoing: set `deletion_protection = false`, apply, then `terraform destroy`.
For portfolio purposes the zero-cost demo above is sufficient; nothing in this repository applies
the Terraform automatically.
