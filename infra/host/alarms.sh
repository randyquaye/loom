#!/usr/bin/env bash
# Pause alarm actions for maintenance. Monitoring still records the outage.
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: alarms.sh STACK pause|resume}"
case "${2:-}" in pause) ACTION=disable-alarm-actions;; resume) ACTION=enable-alarm-actions;; *) exit 1;; esac
NAMES=$(terraform -chdir="$LOOM_INFRA_DIR" output -json alarm_names)
# Read arrays without shell splitting or inventing names; Route 53 alarms live in us-east-1.
while IFS= read -r name; do
  aws cloudwatch "$ACTION" --region "$AWS_REGION" --alarm-names "$name"
done < <(jq -r '.[]' <<<"$NAMES")
HEALTH=$(terraform -chdir="$LOOM_INFRA_DIR" output -raw health_alarm_name)
if [ -n "$HEALTH" ]; then aws cloudwatch "$ACTION" --region us-east-1 --alarm-names "$HEALTH"; fi
