#!/usr/bin/env bash
# All Terraform commands use this wrapper: tf.sh NAME plan -out=NAME.tfplan
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: tf.sh STACK COMMAND [ARGS]}"
shift
terraform -chdir="$LOOM_INFRA_DIR" "$@"
