# Durable hand-off for advisory SOC investigations (INVESTIGATION_QUEUE=sqs).
resource "aws_sqs_queue" "investigations_dlq" {
  name                              = "${local.name}-investigations-dlq"
  message_retention_seconds         = 1209600 # 14 days to inspect and redrive
  kms_master_key_id                 = aws_kms_key.main.arn
  kms_data_key_reuse_period_seconds = 3600
}

resource "aws_sqs_queue" "investigations" {
  name = "${local.name}-investigations"
  # Longer than the worker's 300s receive visibility so in-flight work is not redelivered.
  visibility_timeout_seconds        = 360
  message_retention_seconds         = 345600 # 4 days
  receive_wait_time_seconds         = 20
  kms_master_key_id                 = aws_kms_key.main.arn
  kms_data_key_reuse_period_seconds = 3600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.investigations_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "investigations_dlq" {
  queue_url = aws_sqs_queue.investigations_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.investigations.arn]
  })
}
