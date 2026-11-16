mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      id  = "loombox-public-184375957026-eu-north-1"
      arn = "arn:aws:s3:::loombox-public-184375957026-eu-north-1"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn            = "arn:aws:cloudfront::184375957026:distribution/EXAMPLE123"
      domain_name    = "example.cloudfront.net"
      hosted_zone_id = "Z2FDTNDATAQYW2"
    }
  }
}
mock_provider "aws" {
  alias = "certificate"
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:184375957026:certificate/11111111-2222-3333-4444-555555555555"
      domain_validation_options = [
        {
          domain_name           = "loombox.xyz"
          resource_record_name  = "_root.loombox.xyz."
          resource_record_type  = "CNAME"
          resource_record_value = "_root.acm-validations.aws."
        },
        {
          domain_name           = "www.loombox.xyz"
          resource_record_name  = "_www.loombox.xyz."
          resource_record_type  = "CNAME"
          resource_record_value = "_www.acm-validations.aws."
        }
      ]
    }
  }
}

variables {
  expected_account_id = "184375957026"
  manage_dns          = true
}

run "private_preview" {
  command = apply
  assert {
    condition     = aws_s3_bucket_public_access_block.assets.block_public_acls && aws_s3_bucket_public_access_block.assets.block_public_policy && aws_s3_bucket_public_access_block.assets.ignore_public_acls && aws_s3_bucket_public_access_block.assets.restrict_public_buckets
    error_message = "Public S3 access must remain blocked."
  }
  assert {
    condition     = aws_cloudfront_distribution.site.viewer_certificate[0].cloudfront_default_certificate && length(aws_cloudfront_distribution.site.aliases) == 0
    error_message = "Preview must not activate custom TLS before DNS delegation."
  }
  assert {
    condition     = length(aws_acm_certificate_validation.site) == 0 && length(aws_iam_role.deploy) == 0
    error_message = "Initial hosting must not wait for certificate validation or require IAM."
  }
  assert {
    condition     = aws_cloudfront_cache_policy.feed.min_ttl == 0 && aws_cloudfront_cache_policy.feed.default_ttl == 0 && aws_cloudfront_cache_policy.feed.max_ttl == 0
    error_message = "The update feed must revalidate regardless of uploaded object headers."
  }
  assert {
    condition     = aws_cloudfront_origin_access_control.site.signing_behavior == "always" && aws_cloudfront_origin_access_control.site.signing_protocol == "sigv4"
    error_message = "CloudFront must authenticate every S3 origin request."
  }
  assert {
    condition     = length(aws_route53_zone.site) == 1 && length(aws_route53_record.validation) == 2 && length(aws_route53_record.site) == 0
    error_message = "Only DNS validation records should exist before custom-domain activation."
  }
}

run "production_publisher" {
  command = apply
  variables {
    enable_github_deploy     = true
    github_oidc_provider_arn = "arn:aws:iam::184375957026:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:randyquaye@69855400/loom@1449833159:environment:production"
    error_message = "Only this repository's protected production environment can assume the deployment role."
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "OIDC tokens must target AWS STS."
  }
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "A shared existing GitHub provider must never be recreated."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.deploy[0].policy).Statement :
      statement.Resource == ["arn:aws:s3:::loombox-public-184375957026-eu-north-1/site/*"]
      if contains(statement.Action, "s3:PutObject") || contains(statement.Action, "s3:GetObject") || contains(statement.Action, "s3:AbortMultipartUpload") || contains(statement.Action, "s3:DeleteObject")
    ])
    error_message = "Website deployment must not read or write installer/update objects."
  }
  assert {
    condition = alltrue([
      for prefix in jsondecode(aws_iam_role_policy.deploy[0].policy).Statement[0].Condition.StringLike["s3:prefix"] : startswith(prefix, "site/")
    ])
    error_message = "Website synchronization must list only its site prefix."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.deploy[0].policy).Statement[2].Action == ["s3:DeleteObject"] && jsondecode(aws_iam_role_policy.deploy[0].policy).Statement[2].Resource == ["arn:aws:s3:::loombox-public-184375957026-eu-north-1/site/*"]
    error_message = "Website synchronization must never delete installers or update files."
  }
}
