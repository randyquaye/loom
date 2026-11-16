# A shared GitHub issuer is reused when supplied; enable IAM only after account-policy review.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.enable_github_deploy && var.github_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "deploy" {
  count                = var.enable_github_deploy ? 1 : 0
  name                 = "loombox-site-deploy"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = {
        Federated = var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
      }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:randyquaye@69855400/loom@1449833159:environment:production"
      } }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  count = var.enable_github_deploy ? 1 : 0
  name  = "site-assets-only"
  role  = aws_iam_role.deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.assets.arn]
        Condition = { StringLike = {
          "s3:prefix" = ["site/", "site/*"]
        } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
        Resource = ["${aws_s3_bucket.assets.arn}/site/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.assets.arn}/site/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
        Resource = [aws_cloudfront_distribution.site.arn]
      }
    ]
  })
}
