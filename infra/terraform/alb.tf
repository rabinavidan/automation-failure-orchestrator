# Public by design: it is the SIEM webhook endpoint, restricted by security-group CIDRs and WAF.
resource "aws_lb" "main" {
  #checkov:skip=CKV2_AWS_20:HTTP is redirected to HTTPS whenever certificate_arn is set; plain HTTP requires the explicit allow_insecure_http opt-in
  name                       = substr(local.name, 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_lb_target_group" "ingestion" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; ALB-to-task traffic stays inside private subnets
  name        = substr("${local.name}-api", 0, 32)
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ingestion.arn
  }
}

# With a certificate, port 80 only redirects to HTTPS. Without one (allow_insecure_http,
# demo only) it forwards plain HTTP.
resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:Redirects to HTTPS when a certificate exists; forwards HTTP only with the explicit allow_insecure_http opt-in
  #checkov:skip=CKV_AWS_103:Same listener as above: TLS policy applies to the HTTPS listener
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.certificate_arn != "" ? "redirect" : "forward"
    target_group_arn = var.certificate_arn != "" ? null : aws_lb_target_group.ingestion.arn

    dynamic "redirect" {
      for_each = var.certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}
