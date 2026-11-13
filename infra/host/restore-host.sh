#!/usr/bin/env bash
# Runs only on a NEW rehearsal host with a RESTORED volume. Never on the pilot host.
set -euo pipefail
: "${LOOM_REGION:?}"
: "${LOOM_RESTORED_VOLUME:?}"
: "${LOOM_ARTIFACT_BUCKET:?}"
: "${LOOM_RESTORE_ARCHIVE:?}"
: "${LOOM_RESTORE_INSTANCE:?}"

export DEBIAN_FRONTEND=noninteractive AWS_PAGER=""
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential ca-certificates curl docker.io git gnupg >/dev/null
command -v aws >/dev/null || snap install aws-cli --classic >/dev/null
# Refuse to run on a host with a production service or an already mounted data disk.
if [ -f /etc/systemd/system/loom-runner.service ] || mountpoint -q /var/lib/loom; then
  echo 'Restore rehearsal requires a fresh host' >&2
  exit 1
fi
IDENTITY="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
INSTANCE="$(curl -fsS -H "X-aws-ec2-metadata-token: $IDENTITY" http://169.254.169.254/latest/meta-data/instance-id)"
[ "$INSTANCE" = "$LOOM_RESTORE_INSTANCE" ] || { echo 'This is not the new rehearsal host' >&2; exit 1; }
unset IDENTITY

curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
echo 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' \
  >/etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends nodejs >/dev/null
npm install --global --silent pnpm@11
systemctl enable --now docker >/dev/null

DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${LOOM_RESTORED_VOLUME/-/}"
for _ in $(seq 30); do [ ! -e "$DEVICE" ] || break; sleep 2; done
[ -e "$DEVICE" ] || { echo 'Restored disk did not attach' >&2; exit 1; }
[ "$(lsblk -no FSTYPE "$DEVICE")" = ext4 ] || { echo 'Restored disk is not ext4; it will not be formatted' >&2; exit 1; }
mkdir -p /var/lib/loom /opt/loom/rehearsal
mount "$DEVICE" /var/lib/loom
[ -f /var/lib/loom/loom.db ] || { echo 'Restored disk has no Loom database' >&2; exit 1; }
SAVED_UID="$(stat -c %u /var/lib/loom/loom.db)"
SAVED_GID="$(stat -c %g /var/lib/loom/loom.db)"
[ "$SAVED_UID" -gt 0 ] && [ "$SAVED_GID" -gt 0 ] || { echo 'Restored runner must not run as root' >&2; exit 1; }
getent group "$SAVED_GID" >/dev/null || groupadd --gid "$SAVED_GID" loom
id loom >/dev/null 2>&1 || useradd --uid "$SAVED_UID" --gid "$SAVED_GID" --create-home --shell /bin/bash loom
[ "$(id -u loom)" = "$SAVED_UID" ] || { echo 'Restored file ownership does not match the runner' >&2; exit 1; }
usermod --append --groups docker loom
aws s3 cp --only-show-errors --region "$LOOM_REGION" "s3://$LOOM_ARTIFACT_BUCKET/$LOOM_RESTORE_ARCHIVE" /tmp/loom-restore.tgz
tar -xzf /tmp/loom-restore.tgz -C /opt/loom/rehearsal
rm /tmp/loom-restore.tgz
chown -R loom:loom /opt/loom/rehearsal
sudo -u loom -H sh -c 'cd /opt/loom/rehearsal && pnpm install --prod --frozen-lockfile --reporter=append-only' | tail -n 5

# No sign-in fronts, login service, model calls, Docker image, public listener, or DNS.
# The key stays in the process environment; no secret is copied to output or arguments.
LOOM_SECRET_KEY="$(aws ssm get-parameter --region "$LOOM_REGION" --name /loom/secret-key \
  --with-decryption --query Parameter.Value --output text)"
export LOOM_SECRET_KEY
cd /opt/loom/rehearsal
sudo --preserve-env=LOOM_SECRET_KEY -u loom -H node out/main/restore-check.js /var/lib/loom --isolated-copy
unset LOOM_SECRET_KEY
