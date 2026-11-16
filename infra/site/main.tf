terraform {
  required_version = ">= 1.10"
  backend "s3" {}
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags { tags = { Project = "loombox-site" } }
}

# CloudFront accepts ACM certificates only from us-east-1.
provider "aws" {
  alias               = "certificate"
  region              = "us-east-1"
  allowed_account_ids = [var.expected_account_id]
  default_tags { tags = { Project = "loombox-site" } }
}

locals {
  bucket_name = "loombox-public-${var.expected_account_id}-${var.region}"
  domains     = [var.domain, "www.${var.domain}"]
  prefixes    = ["site/", "updates/mac/", "downloads/"]
}

resource "aws_s3_bucket" "assets" {
  bucket        = local.bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "loombox-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "assets" {
  name        = "loombox-static-assets"
  min_ttl     = 0
  default_ttl = 300
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# A feed request must not reuse stale metadata even if an uploader omits Cache-Control.
resource "aws_cloudfront_cache_policy" "feed" {
  name        = "loombox-update-feed"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Loom website and signed desktop updates"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  aliases             = var.activate_custom_domain ? local.domains : []

  dynamic "origin" {
    for_each = { site = "/site", assets = "" }
    content {
      origin_id                = origin.key
      domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
      origin_path              = origin.value
      origin_access_control_id = aws_cloudfront_origin_access_control.site.id
    }
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = aws_cloudfront_cache_policy.assets.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = ["updates/mac/latest-mac.yml", "updates/*", "downloads/*"]
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = "assets"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = ordered_cache_behavior.value == "updates/mac/latest-mac.yml" ? aws_cloudfront_cache_policy.feed.id : aws_cloudfront_cache_policy.assets.id
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    cloudfront_default_certificate = !var.activate_custom_domain
    acm_certificate_arn            = var.activate_custom_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = var.activate_custom_domain ? "sni-only" : null
    minimum_protocol_version       = var.activate_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontReadOnly"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = [for prefix in local.prefixes : "${aws_s3_bucket.assets.arn}/${prefix}*"]
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
      },
      {
        Sid       = "RequireTLS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.assets.arn, "${aws_s3_bucket.assets.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.assets]
}

resource "aws_acm_certificate" "site" {
  provider                  = aws.certificate
  domain_name               = var.domain
  subject_alternative_names = ["www.${var.domain}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_zone" "site" {
  count = var.manage_dns ? 1 : 0
  name  = var.domain
}

resource "aws_route53_record" "validation" {
  for_each = var.manage_dns ? toset(local.domains) : toset([])
  zone_id  = aws_route53_zone.site[0].zone_id
  name     = one([for record in aws_acm_certificate.site.domain_validation_options : record.resource_record_name if record.domain_name == each.key])
  type     = "CNAME"
  ttl      = 300
  records  = [one([for record in aws_acm_certificate.site.domain_validation_options : record.resource_record_value if record.domain_name == each.key])]
}

# Initial apply emits delegation/CNAME records without waiting for registrar changes.
resource "aws_acm_certificate_validation" "site" {
  count                   = var.activate_custom_domain ? 1 : 0
  provider                = aws.certificate
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for record in aws_acm_certificate.site.domain_validation_options : record.resource_record_name]
  depends_on              = [aws_route53_record.validation]
  timeouts { create = "10m" }
}

resource "aws_route53_record" "site" {
  for_each = var.manage_dns && var.activate_custom_domain ? {
    for pair in setproduct(local.domains, ["A", "AAAA"]) : "${pair[0]}-${pair[1]}" => pair
  } : {}
  zone_id = aws_route53_zone.site[0].zone_id
  name    = each.value[0]
  type    = each.value[1]
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
