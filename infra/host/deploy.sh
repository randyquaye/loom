#!/usr/bin/env bash
# Builds the runner on this Mac and puts it on the pilot host. The host has no SSH port:
# the release goes through the artifact bucket and every command through AWS Systems Manager.
#
#   infra/host/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

export AWS_PROFILE="${AWS_PROFILE:-loom}" AWS_PAGER=""
output() { terraform -chdir=infra/host output -raw "$1"; }
REGION="$(output region)"
INSTANCE="$(output instance_id)"
BUCKET="$(output artifact_bucket)"
RUNTIME="$(output workspace_container_runtime 2>/dev/null || printf runc)"
case "$RUNTIME" in runc|kata) ;; *) echo 'Invalid workspace container runtime' >&2; exit 1;; esac
RELEASE="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

pnpm build
ARCHIVE="$(mktemp -d)/$RELEASE.tgz"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE" \
  package.json pnpm-lock.yaml pnpm-workspace.yaml \
  out/main/runner.js out/main/restore-check.js out/main/chunks images/workspace images/workspace-kata infra/kata \
  infra/host/setup.sh infra/host/loom-workspace.apparmor infra/host/restore-host.sh
aws s3 cp --only-show-errors --region "$REGION" "$ARCHIVE" "s3://$BUCKET/releases/$RELEASE.tgz"

# What runs on the host: fetch the release, unpack it, and let setup.sh do the rest.
REMOTE="$(
  cat <<SCRIPT
set -euo pipefail
export PATH="\$PATH:/snap/bin"
command -v aws >/dev/null || snap install aws-cli --classic >/dev/null
install -d /opt/loom/releases/$RELEASE
aws s3 cp --only-show-errors --region $REGION s3://$BUCKET/releases/$RELEASE.tgz /tmp/$RELEASE.tgz
tar -xzf /tmp/$RELEASE.tgz -C /opt/loom/releases/$RELEASE
rm /tmp/$RELEASE.tgz
export LOOM_HOSTNAME=$(output hostname) LOOM_REGION=$REGION
export LOOM_DATA_VOLUME_ID=$(output data_volume_id) LOOM_RELEASE=/opt/loom/releases/$RELEASE
export LOOM_WORKSPACE_CONTAINER_RUNTIME=$RUNTIME
bash /opt/loom/releases/$RELEASE/infra/host/setup.sh
SCRIPT
)"

# A machine that has just been made takes a minute or two to report in.
until [ "$(aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE" \
  --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ]; do
  echo "Waiting for $INSTANCE to report in."
  sleep 10
done

# Sent encoded, so the host's own shell and its quoting rules never touch the script.
ENCODED="$(printf '%s' "$REMOTE" | base64 | tr -d '\n')"
COMMAND="$(
  aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
    --document-name AWS-RunShellScript --comment "Loom release $RELEASE" \
    --parameters "$(jq -n --arg run "echo $ENCODED | base64 -d | bash" \
      '{commands: [$run], executionTimeout: ["1800"]}')" \
    --query Command.CommandId --output text
)"

echo "Release $RELEASE is being set up on $INSTANCE."
invocation() {
  aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND" \
    --instance-id "$INSTANCE" --query "$1" --output text 2>/dev/null || echo Pending
}
while STATUS="$(invocation Status)" && [[ "$STATUS" == Pending || "$STATUS" == InProgress ]]; do
  sleep 5
done
invocation StandardOutputContent | tail -n 40
if [ "$STATUS" != Success ]; then
  invocation StandardErrorContent | tail -n 40 >&2
  echo "The release failed on the host ($STATUS)." >&2
  exit 1
fi
