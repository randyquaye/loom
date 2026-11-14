#!/usr/bin/env bash
# Drain rejects new work; inspect the returned active work before deploying or stopping.
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: drain.sh STACK [on|off|status]}"
MODE=${2:-status}
case "$MODE" in on) METHOD=POST; DATA='{"draining":true}';; off) METHOD=POST; DATA='{"draining":false}';; status) METHOD=GET; DATA='';; *) exit 1;; esac
INSTANCE=$(terraform -chdir="$LOOM_INFRA_DIR" output -raw instance_id)
# The token is read only on the host. It is not returned through Systems Manager.
REMOTE="$(cat <<SCRIPT
set -euo pipefail
printf 'Authorization: Bearer %s\n' "\$(cat /etc/loom/operator.token)" |
  curl -fsS --max-time 15 -X $METHOD -H @- -H 'Content-Type: application/json' \\
    --data '$DATA' http://127.0.0.1:3877/admin/drain
SCRIPT
)"
COMMAND=$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "$(jq -nc --arg command "$REMOTE" '{commands:[$command]}')" \
  --comment "Loom drain $MODE" --query Command.CommandId --output text)
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$COMMAND" --instance-id "$INSTANCE" || true
RESULT=$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$COMMAND" --instance-id "$INSTANCE" --output json)
jq -r .StandardOutputContent <<<"$RESULT"
if [ "$(jq -r .Status <<<"$RESULT")" != Success ]; then
  jq -r .StandardErrorContent <<<"$RESULT" >&2
  exit 1
fi
