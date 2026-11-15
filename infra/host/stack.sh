#!/usr/bin/env bash
# Shared by every operator command. Stack files are trusted shell, never secret stores.
load_stack() {
  local name="${1:-loom}" actual file
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,16}$ ]] || { echo 'Invalid stack name' >&2; return 1; }
  LOOM_INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  file="${LOOM_STACK_DIR:-$LOOM_INFRA_DIR/stacks}/$name.env"
  [ -f "$file" ] || { echo "Create $file from infra/host/stacks/example.env first" >&2; return 1; }
  # A tfvars file takes precedence over TF_VAR inputs without saying so.
  if find "$LOOM_INFRA_DIR" -maxdepth 1 -type f \( -name '*.tfvars' -o -name '*.tfvars.json' \) | read -r _; then
    echo 'Remove tfvars files; the stack file is the only configuration source' >&2
    return 1
  fi
  # Values omitted by this stack must not leak from the calling shell or a prior stack.
  local variable
  while IFS= read -r variable; do unset "$variable"; done < <(compgen -A variable TF_VAR_)
  unset AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION EXPECTED_ACCOUNT_ID STACK_NAME
  unset LOOM_MAX_RUNNING_WORKSPACES LOOM_MIN_FREE_DISK_GB
  unset LOOM_RELEASE_REPOSITORY
  set -a
  # shellcheck source=/dev/null
  source "$file"
  set +a
  : "${AWS_PROFILE:?set AWS_PROFILE in the stack file}"
  : "${AWS_REGION:?set AWS_REGION in the stack file}"
  : "${EXPECTED_ACCOUNT_ID:?set EXPECTED_ACCOUNT_ID in the stack file}"
  : "${STACK_NAME:?set STACK_NAME in the stack file}"
  : "${TF_VAR_hostname:?set TF_VAR_hostname in the stack file}"
  [ "$STACK_NAME" = "$name" ] || { echo 'Stack filename and STACK_NAME differ' >&2; return 1; }
  [[ "$EXPECTED_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || { echo 'Expected account must have 12 digits' >&2; return 1; }
  [[ "$AWS_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || { echo 'Invalid AWS Region' >&2; return 1; }
  [[ "$TF_VAR_hostname" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo 'Use a lowercase DNS hostname' >&2; return 1; }
  export AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
  actual="$(aws sts get-caller-identity --query Account --output text)" || return 1
  [ "$actual" = "$EXPECTED_ACCOUNT_ID" ] || {
    echo "Wrong AWS account: expected $EXPECTED_ACCOUNT_ID, received $actual. No changes made." >&2
    return 1
  }
  export TF_VAR_region="$AWS_REGION" TF_VAR_stack_name="$STACK_NAME" TF_VAR_expected_account_id="$EXPECTED_ACCOUNT_ID"
  export TF_DATA_DIR="$LOOM_INFRA_DIR/.terraform/$STACK_NAME"
  export LOOM_PARAMETER_PREFIX="/$STACK_NAME"
  if [ "$STACK_NAME" = loom ]; then
    LOOM_STATE_BUCKET="loom-pilot-tfstate-$EXPECTED_ACCOUNT_ID"
    LOOM_STATE_KEY=host/terraform.tfstate
  else
    LOOM_STATE_BUCKET="loom-$STACK_NAME-tfstate-$EXPECTED_ACCOUNT_ID-$AWS_REGION"
    LOOM_STATE_KEY="stacks/$STACK_NAME/host/terraform.tfstate"
  fi
  export LOOM_STATE_BUCKET LOOM_STATE_KEY
}
