# A rehearsal must never inherit the pilot host's OAuth settings or write its vault key.
resource "aws_iam_role" "restore" {
  name = "${local.global_prefix}-restore-check"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "restore_administration" {
  role       = aws_iam_role.restore.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "restore" {
  name = "isolated-restore-check"
  role = aws_iam_role.restore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.artifacts.arn}/releases/loom-restore-*"
      },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = ["${local.parameter_arn}/secret-key", "${local.parameter_arn}/runner-signing-key"]
      },
      # SSM's managed core policy otherwise grants GetParameter(s) on every parameter.
      {
        Effect      = "Deny"
        Action      = "ssm:GetParameter*"
        NotResource = ["${local.parameter_arn}/secret-key", "${local.parameter_arn}/runner-signing-key"]
      },
      {
        Effect   = "Deny"
        Action   = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "restore" {
  name = "${local.global_prefix}-restore-check"
  role = aws_iam_role.restore.name
}
