terraform {
  # >= 1.9 for cross-variable validation (HTTPS-or-explicit-opt-in check).
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state: supply bucket/key/region with `terraform init -backend-config=backend.hcl`
  # (see backend.hcl.example). State contains secrets metadata: keep the bucket private,
  # versioned and encrypted.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = var.github_repository
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_availability_zones" "available" {
  #checkov:skip=CKV_AWS_394:Only the first two AZs are used (slice), so new AZs cannot change placement
  state = "available"
}
