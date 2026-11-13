# A rehearsal must never inherit the pilot host's OAuth settings or write its vault key.
resource "aws_iam_role" "restore" {
  name = "loom-pilot-restore-check"
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
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/loom/secret-key"
      },
      # SSM's managed core policy otherwise grants GetParameter(s) on every parameter.
      {
        Effect      = "Deny"
        Action      = "ssm:GetParameter*"
        NotResource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/loom/secret-key"
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
  name = "loom-pilot-restore-check"
  role = aws_iam_role.restore.name
}
