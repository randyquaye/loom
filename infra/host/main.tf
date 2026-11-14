# The Loom pilot host: one always-on machine, one data disk, one open port.
#
#   infra/host/init.sh NAME
#   infra/host/tf.sh NAME plan -out=NAME.tfplan
#   infra/host/tf.sh NAME apply NAME.tfplan
#
# This only makes the machine. infra/host/deploy.sh puts Loom on it.

terraform {
  required_version = ">= 1.10"

  # The state is the only record of what this made, so it is kept in the project itself and
  # not on anyone's laptop. The bucket is named when Terraform is initialised, by init.sh,
  # because its name holds the account's number, which does not belong in the repository.
  backend "s3" {
    key          = "host/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }

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

  default_tags {
    tags = { Project = local.prefix }
  }
}

data "aws_caller_identity" "current" {}

locals {
  legacy         = var.stack_name == "loom"
  prefix         = local.legacy ? "loom-pilot" : "loom-${var.stack_name}"
  global_prefix  = local.legacy ? local.prefix : "${local.prefix}-${data.aws_caller_identity.current.account_id}-${var.region}"
  parameter_path = "/${var.stack_name}"
  parameter_arn  = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.parameter_path}"
  backup_tag     = local.legacy ? "pilot-data" : "${local.prefix}-${data.aws_caller_identity.current.account_id}-${var.region}-data"
}

data "aws_vpc" "default" {
  count   = var.subnet_id == null ? 1 : 0
  default = true
}

# The data disk can only attach to a machine in its own zone, so both follow this subnet.
data "aws_subnet" "host" {
  id = var.subnet_id
  dynamic "filter" {
    for_each = var.subnet_id == null ? {
      vpc-id            = data.aws_vpc.default[0].id
      availability-zone = "${var.region}a"
      default-for-az    = "true"
    } : {}
    content {
      name   = filter.key
      values = [filter.value]
    }
  }
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

# --- Network: the internet reaches port 443 and nothing else. There is no SSH port;
# administration goes through AWS Systems Manager, which the machine calls out to.

resource "aws_security_group" "host" {
  name        = "${local.prefix}-host"
  description = "Loom pilot host: HTTPS in, anything out"
  vpc_id      = data.aws_subnet.host.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.host.id
  description       = "The runner, behind its TLS proxy"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.host.id
  description       = "Git remotes, package registries, agent APIs, AWS itself"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# --- What the machine itself may do in AWS: be administered, fetch its own releases,
# read its own settings. Nothing else.

resource "aws_iam_role" "host" {
  name = "${local.global_prefix}-host"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "administration" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "host" {
  name = "releases-and-settings"
  role = aws_iam_role.host.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.artifacts.arn}/releases/*"
      },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "${local.parameter_arn}/*"
      },
      {
        Effect      = "Deny"
        Action      = "ssm:GetParameter*"
        NotResource = "${local.parameter_arn}/*"
      },
      {
        Effect   = "Deny"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameterHistory", "ssm:DeleteParameter", "ssm:DeleteParameters"]
        Resource = "*"
      },
      {
        Effect    = "Allow"
        Action    = "ssm:PutParameter"
        Resource  = ["${local.parameter_arn}/secret-key", "${local.parameter_arn}/runner-signing-key"]
        Condition = { StringEquals = { "ssm:Overwrite" = "false" } }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.global_prefix}-host"
  role = aws_iam_role.host.name
}

# --- Releases travel through this bucket, since nothing can be copied to the machine directly.

resource "aws_s3_bucket" "artifacts" {
  bucket        = local.legacy ? "loom-pilot-artifacts-${data.aws_caller_identity.current.account_id}" : "${local.global_prefix}-artifacts"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "old-releases"
    status = "Enabled"

    filter {
      prefix = "releases/"
    }

    expiration {
      days = 14
    }
  }
}

# --- The machine.

resource "aws_instance" "host" {
  ami                    = nonsensitive(data.aws_ssm_parameter.ubuntu.value)
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.host.id
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  dynamic "cpu_options" {
    for_each = var.enable_kata_workspaces ? [true] : []
    content {
      nested_virtualization = "enabled"
    }
  }

  # A hop limit of 1 keeps the machine's own AWS credentials out of reach of workspace
  # containers, which sit one network hop further in and run code nobody has reviewed.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_gb
    encrypted   = true
  }

  tags = { Name = local.prefix }

  lifecycle {
    # "current" moves whenever Ubuntu publishes an image; that must not replace a running host.
    ignore_changes = [ami]
  }
}

# The data disk is its own resource so that replacing the machine never touches it.
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.host.availability_zone
  type              = "gp3"
  size              = var.data_gb
  encrypted         = true

  tags = { Name = "${local.prefix}-data", LoomBackup = local.backup_tag }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.host.id
  stop_instance_before_detaching = true
}

# A fixed address, so the DNS record survives a stop, a start or a new machine.
resource "aws_eip" "host" {
  domain = "vpc"
  tags   = { Name = local.prefix }
}

resource "aws_eip_association" "host" {
  allocation_id = aws_eip.host.id
  instance_id   = aws_instance.host.id
}
