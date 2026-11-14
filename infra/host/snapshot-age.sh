#!/usr/bin/env bash
# Missing or failed reporting alarms too; never publish a fabricated healthy age.
set -euo pipefail
: "${LOOM_REGION:?}"
: "${LOOM_STACK_NAME:?}"
: "${LOOM_DATA_VOLUME_ID:?}"
: "${LOOM_HOSTNAME:?}"
TLS_READY=0
if curl -fsS --max-time 15 --resolve "$LOOM_HOSTNAME:443:127.0.0.1" "https://$LOOM_HOSTNAME/healthz" >/dev/null; then TLS_READY=1; fi
aws cloudwatch put-metric-data --region "$LOOM_REGION" --namespace Loom/Host \
  --metric-name TlsReady --dimensions "Stack=$LOOM_STACK_NAME" --value "$TLS_READY" --unit Count
LATEST=$(aws ec2 describe-snapshots --region "$LOOM_REGION" --owner-ids self \
  --filters "Name=volume-id,Values=$LOOM_DATA_VOLUME_ID" Name=status,Values=completed \
  --query 'sort_by(Snapshots,&StartTime)[-1].StartTime' --output text)
AGE=$(python3 - "$LATEST" <<'PY'
import datetime, sys
value = sys.argv[1]
if value in ('None', 'null', ''):
    print(1_000_000)
else:
    latest = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    print(max(0, (datetime.datetime.now(datetime.timezone.utc) - latest).total_seconds() / 3600))
PY
)
aws cloudwatch put-metric-data --region "$LOOM_REGION" --namespace Loom/Host \
  --metric-name SnapshotAgeHours --dimensions "Stack=$LOOM_STACK_NAME" --value "$AGE" --unit None
