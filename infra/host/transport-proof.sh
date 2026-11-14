#!/usr/bin/env bash
# Mandatory for every production runner, independently of optional monitoring.
set -euo pipefail
: "${LOOM_HOSTNAME:?}"
: "${LOOM_RELEASE_ID:?}"
# setup.sh copied this publisher and its chunks before any user-writable installation.
cat >/etc/systemd/system/loom-transport-proof.service <<UNIT
[Unit]
Description=Authorize Caddy's current TLS key with the organization's runner key
After=network-online.target caddy.service
Wants=network-online.target
Requisite=caddy.service
[Service]
Type=oneshot
User=root
Group=root
UMask=0022
ExecStart=/usr/bin/node /etc/loom/transport-publisher/$LOOM_RELEASE_ID/transport-proof.js $LOOM_HOSTNAME /etc/loom/runner-signing.pem /etc/loom/transport-proof.json
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/loom
UNIT
cat >/etc/systemd/system/loom-transport-proof.timer <<'UNIT'
[Unit]
Description=Refresh Loom TLS authorization every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now loom-transport-proof.timer >/dev/null
# A new certificate may still be issuing. The timer retries; readiness remains closed meanwhile.
systemctl start --no-block loom-transport-proof.service
