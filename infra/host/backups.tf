# Daily crash-consistent snapshots of the complete data disk, including SQLite's WAL.
# The separately encrypted vault key is recovered from SSM, never from this volume.
resource "aws_iam_role" "backups" {
  name = "${local.global_prefix}-backups"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "dlm.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backups" {
  role       = aws_iam_role.backups.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = local.legacy ? "Daily Loom pilot data backup" : "Daily Loom ${var.stack_name} data backup"
  execution_role_arn = aws_iam_role.backups.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { LoomBackup = local.backup_tag }

    schedule {
      name      = "daily"
      copy_tags = true
      tags_to_add = {
        LoomBackup = "${local.backup_tag}-snapshot"
      }
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = [var.snapshot_time_utc]
      }
      retain_rule {
        count = var.snapshot_retention
      }
    }
  }
  depends_on = [aws_iam_role_policy_attachment.backups]
}
