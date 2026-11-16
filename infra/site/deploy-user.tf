# Programmatic credentials are created outside Terraform and stored directly in GitHub.
resource "aws_iam_user" "deploy" {
  count         = var.enable_github_deploy ? 1 : 0
  name          = "loombox-site-deploy"
  force_destroy = false
}

resource "aws_iam_user_policy" "deploy" {
  count = var.enable_github_deploy ? 1 : 0
  name  = "site-assets-only"
  user  = aws_iam_user.deploy[0].name
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
