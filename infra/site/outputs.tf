output "bucket" {
  value = aws_s3_bucket.assets.id
}
output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}
output "distribution_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}
output "preview_url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}
output "domain" {
  value = var.domain
}
output "certificate_arn" {
  value = aws_acm_certificate.site.arn
}
output "certificate_dns_records" {
  value = { for record in aws_acm_certificate.site.domain_validation_options : record.domain_name => {
    name  = record.resource_record_name
    type  = record.resource_record_type
    value = record.resource_record_value
  } }
}
output "nameservers" {
  description = "Set all four as custom nameservers at GoDaddy; do not add NS records inside its DNS editor."
  value       = var.manage_dns ? aws_route53_zone.site[0].name_servers : []
}
output "github_deploy_role_arn" {
  value = var.enable_github_deploy ? aws_iam_role.deploy[0].arn : null
}
output "desktop_update_url" {
  description = "Use only after the custom domain is activated and signed release assets are published."
  value       = "https://${var.domain}/updates/mac/"
}
