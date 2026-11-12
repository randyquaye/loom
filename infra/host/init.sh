#!/usr/bin/env bash
# Points Terraform at the host's state, which is kept in a bucket of the project's own, and
# makes that bucket the first time. Run once in each checkout, before plan, apply or deploy.
# Anything after the script's name is passed on to `terraform init`.
#
#   infra/host/init.sh
set -euo pipefail
cd "$(dirname "$0")"

export AWS_PROFILE="${AWS_PROFILE:-loom}" AWS_PAGER=""
REGION="${AWS_REGION:-eu-north-1}"
BUCKET="loom-pilot-tfstate-$(aws sts get-caller-identity --query Account --output text)"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  # Every earlier state is kept, so a bad apply can be looked back from.
  aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  echo "Made $BUCKET for the host's Terraform state."
fi

terraform init -input=false -backend-config="bucket=$BUCKET" -backend-config="region=$REGION" "$@"
