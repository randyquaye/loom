#!/usr/bin/env bash
# Configure the already-installed agent; installation is an explicit host preparation step.
set -euo pipefail
: "${LOOM_REGION:?}"
: "${LOOM_STACK_NAME:?}"
: "${LOOM_DATA_VOLUME_ID:?}"
: "${LOOM_RELEASE:?}"
AGENT=/opt/aws/amazon-cloudwatch-agent
[ -x "$AGENT/bin/amazon-cloudwatch-agent-ctl" ] || {
  echo 'CloudWatch agent missing; drain and deploy with --prepare' >&2; exit 1;
}
cat >"$AGENT/etc/loom.json" <<'JSON'
{
  "agent": { "metrics_collection_interval": 60, "omit_hostname": true },
  "metrics": {
    "namespace": "Loom/Host",
    "append_dimensions": { "InstanceId": "${aws:InstanceId}" },
    "aggregation_dimensions": [["InstanceId", "path"]],
    "metrics_collected": {
      "disk": { "resources": ["/", "/var/lib/loom"], "measurement": ["used_percent"], "drop_device": true, "drop_original_metrics": ["disk_used_percent"] },
      "mem": { "measurement": ["used_percent"] }
    }
  }
}
JSON
"$AGENT/bin/amazon-cloudwatch-agent-ctl" -a fetch-config -m ec2 -s -c "file:$AGENT/etc/loom.json" >/dev/null
cat >/etc/loom/monitoring.env <<ENV
LOOM_REGION=$LOOM_REGION
LOOM_STACK_NAME=$LOOM_STACK_NAME
LOOM_DATA_VOLUME_ID=$LOOM_DATA_VOLUME_ID
LOOM_HOSTNAME=$LOOM_HOSTNAME
ENV
cat >/etc/systemd/system/loom-snapshot-age.service <<UNIT
[Unit]
Description=Report the age of Loom's most recent completed snapshot
After=network-online.target
[Service]
Type=oneshot
EnvironmentFile=/etc/loom/monitoring.env
ExecStart=/bin/bash $LOOM_RELEASE/infra/host/snapshot-age.sh
UNIT
cat >/etc/systemd/system/loom-snapshot-age.timer <<'UNIT'
[Unit]
Description=Check Loom backup age every five minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now loom-snapshot-age.timer >/dev/null
