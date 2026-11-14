output "region" {
  value = var.region
}

output "hostname" {
  value = var.hostname
}

output "public_ip" {
  description = "Point the hostname's A record here."
  value       = aws_eip.host.public_ip
}

output "instance_id" {
  value = aws_instance.host.id
}

output "workspace_container_runtime" {
  value = var.enable_kata_workspaces ? "kata" : "runc"
}

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "backup_policy_id" {
  value = aws_dlm_lifecycle_policy.data.id
}

output "recovery_key_parameter" {
  value = "${local.parameter_path}/secret-key"
}

output "parameter_prefix" {
  value = local.parameter_path
}

output "runner_key_parameter" {
  value = "${local.parameter_path}/runner-signing-key"
}

output "restore_instance_profile_arn" {
  value = aws_iam_instance_profile.restore.arn
}
