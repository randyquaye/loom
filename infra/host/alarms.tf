# Route 53 health-check metrics live in us-east-1, independently of the host's Region.
provider "aws" {
  alias               = "health"
  region              = "us-east-1"
  allowed_account_ids = [var.expected_account_id]
}

resource "aws_sns_topic" "alarms" {
  count = var.alarm_email == null ? 0 : 1
  name  = "${local.global_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarms" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_sns_topic" "health" {
  count    = var.alarm_email == null ? 0 : 1
  provider = aws.health
  name     = "${local.global_prefix}-health"
}

resource "aws_sns_topic_subscription" "health" {
  count     = var.alarm_email == null ? 0 : 1
  provider  = aws.health
  topic_arn = aws_sns_topic.health[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_route53_health_check" "runner" {
  count             = var.alarm_email == null ? 0 : 1
  fqdn              = var.hostname
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30
  enable_sni        = true
  tags              = { Name = "${local.prefix}-runner" }
}

resource "aws_cloudwatch_metric_alarm" "readiness" {
  count               = var.alarm_email == null ? 0 : 1
  provider            = aws.health
  alarm_name          = "${local.global_prefix}-readiness"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.runner[0].id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.health[0].arn]
  ok_actions          = [aws_sns_topic.health[0].arn]
}

resource "aws_cloudwatch_metric_alarm" "disk" {
  for_each            = var.alarm_email == null ? {} : { root = "/", data = "/var/lib/loom" }
  alarm_name          = "${local.global_prefix}-${each.key}-disk"
  namespace           = "Loom/Host"
  metric_name         = "disk_used_percent"
  dimensions          = { InstanceId = aws_instance.host.id, path = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
}

resource "aws_cloudwatch_metric_alarm" "snapshot_failure" {
  count               = var.alarm_email == null ? 0 : 1
  alarm_name          = "${local.global_prefix}-snapshot-failure"
  namespace           = "AWS/EBS"
  metric_name         = "SnapshotsCreateFailed"
  dimensions          = { DLMPolicyId = aws_dlm_lifecycle_policy.data.id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
}

resource "aws_cloudwatch_metric_alarm" "snapshot_age" {
  count               = var.alarm_email == null ? 0 : 1
  alarm_name          = "${local.global_prefix}-snapshot-age"
  namespace           = "Loom/Host"
  metric_name         = "SnapshotAgeHours"
  dimensions          = { Stack = var.stack_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 26
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
}

# Route 53 does not validate certificate trust or expiry. The host's curl does.
resource "aws_cloudwatch_metric_alarm" "tls" {
  count               = var.alarm_email == null ? 0 : 1
  alarm_name          = "${local.global_prefix}-tls"
  namespace           = "Loom/Host"
  metric_name         = "TlsReady"
  dimensions          = { Stack = var.stack_name }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms[0].arn]
  ok_actions          = [aws_sns_topic.alarms[0].arn]
}

resource "aws_iam_role_policy" "monitoring" {
  count = var.alarm_email == null ? 0 : 1
  name  = "host-metrics"
  role  = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = "cloudwatch:PutMetricData"
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "Loom/Host" } }
      },
      { Effect = "Allow", Action = "ec2:DescribeSnapshots", Resource = "*" }
    ]
  })
}

output "alarm_names" {
  value = var.alarm_email == null ? [] : concat(
    [aws_cloudwatch_metric_alarm.snapshot_failure[0].alarm_name, aws_cloudwatch_metric_alarm.snapshot_age[0].alarm_name, aws_cloudwatch_metric_alarm.tls[0].alarm_name],
    [for alarm in aws_cloudwatch_metric_alarm.disk : alarm.alarm_name]
  )
}

output "health_alarm_name" {
  value = var.alarm_email == null ? "" : aws_cloudwatch_metric_alarm.readiness[0].alarm_name
}
