#!/usr/bin/env bash
# Initialise one stack's remote state. Extra arguments go to terraform init.
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: init.sh STACK [TERRAFORM_INIT_ARGS]}"
shift
ERROR=$(mktemp)
trap 'rm -f "$ERROR"' EXIT
if ! aws s3api head-bucket --bucket "$LOOM_STATE_BUCKET" 2>"$ERROR"; then
  if ! grep -Eq '404|Not Found|NoSuchBucket' "$ERROR"; then
    cat "$ERROR" >&2
    exit 1
  fi
  if [ "$AWS_REGION" = us-east-1 ]; then
    aws s3api create-bucket --bucket "$LOOM_STATE_BUCKET" --region "$AWS_REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$LOOM_STATE_BUCKET" --region "$AWS_REGION" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$LOOM_STATE_BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-versioning --bucket "$LOOM_STATE_BUCKET" --versioning-configuration Status=Enabled
  echo "Made $LOOM_STATE_BUCKET for the stack's Terraform state."
fi
terraform -chdir="$LOOM_INFRA_DIR" init -input=false \
  -backend-config="bucket=$LOOM_STATE_BUCKET" -backend-config="region=$AWS_REGION" \
  -backend-config="key=$LOOM_STATE_KEY" "$@"
