#!/usr/bin/env bash
# Host maintenance only; setup.sh requires a drain before calling this on a live host.
set -euo pipefail
: "${LOOM_RELEASE:?}"
: "${LOOM_HOSTNAME:?}"
: "${LOOM_DATA_VOLUME_ID:?}"
DATA_DIR=/var/lib/loom
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n== %s\n' "$1"; }
step "Packages"
# Quiet on purpose: Systems Manager keeps only the start of a command's output.
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential ca-certificates curl docker.io gh git gnupg jq openssl python3 >/dev/null

if [ ! -f /etc/apt/sources.list.d/nodesource.list ]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
fi
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    >/etc/apt/sources.list.d/caddy-stable.list
fi
apt-get update -qq
apt-get install -y -qq --no-install-recommends caddy nodejs >/dev/null
command -v pnpm >/dev/null || npm install --global --silent pnpm@11

step "Data disk"
# Named by its volume id, so no other disk can ever be mistaken for it.
DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${LOOM_DATA_VOLUME_ID/-/}"
for _ in $(seq 30); do
  if [ -e "$DEVICE" ]; then break; fi
  sleep 2
done
[ -e "$DEVICE" ] || { echo "The data disk $LOOM_DATA_VOLUME_ID is not attached" >&2; exit 1; }
# Only a disk with nothing on it is formatted.
if [ -z "$(lsblk -no FSTYPE "$DEVICE")" ]; then mkfs.ext4 -q -L loom-data "$DEVICE"; fi
mkdir -p "$DATA_DIR"
grep -q 'LABEL=loom-data' /etc/fstab ||
  echo "LABEL=loom-data $DATA_DIR ext4 defaults,nofail 0 2" >>/etc/fstab
mountpoint -q "$DATA_DIR" || mount "$DATA_DIR"

step "Runner user"
id loom >/dev/null 2>&1 || useradd --create-home --shell /bin/bash loom
usermod --append --groups docker loom
chown loom:loom "$DATA_DIR"
# Checkpoints are commits; without an identity git refuses to make them.
sudo -u loom git config --global user.name 'Loom'
sudo -u loom git config --global user.email "loom@$LOOM_HOSTNAME"


if [ "${LOOM_WORKSPACE_CONTAINER_RUNTIME:-runc}" = kata ]; then
  bash "$LOOM_RELEASE/infra/kata/install.sh"
fi
install -m 0644 "$LOOM_RELEASE/infra/host/loom-workspace.apparmor" /etc/apparmor.d/loom-workspace
apparmor_parser --replace /etc/apparmor.d/loom-workspace
install -d -m 0750 -o root -g loom /etc/loom
if [ "${LOOM_MONITORING_ENABLED:-0}" = 1 ] && [ ! -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]; then
  AGENT_PACKAGE=$(mktemp --suffix=.deb)
  curl -fsSL --retry 3 https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -o "$AGENT_PACKAGE"
  dpkg -i "$AGENT_PACKAGE" >/dev/null
  rm -f "$AGENT_PACKAGE"
fi
touch /etc/loom/prepared
