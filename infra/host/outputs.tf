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

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}
