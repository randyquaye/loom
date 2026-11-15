#!/usr/bin/env bash
# Activate a verified release, or build a reviewed source checkout, through Systems Manager.
set -euo pipefail
source "$(dirname "$0")/stack.sh"
STACK=${1:?Usage: deploy.sh STACK [--prepare] [--release runner-vVERSION]}
shift
MODE=
TAG=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepare) MODE=--prepare; shift ;;
    --release) TAG=${2:?Expected a release tag after --release}; shift 2 ;;
    *) echo 'Expected --prepare or --release runner-vVERSION' >&2; exit 1 ;;
  esac
done
load_stack "$STACK"
if [ -f "$LOOM_INFRA_DIR/operator-release.txt" ]; then
  [ "$TAG" = "$(cat "$LOOM_INFRA_DIR/operator-release.txt")" ] || {
    echo 'Use --release with the exact tag that supplied this operator bundle' >&2; exit 1
  }
fi
cd "$LOOM_INFRA_DIR/../.."
: "${LOOM_MAX_RUNNING_WORKSPACES:?set the measured cap in the stack file}"
: "${LOOM_MIN_FREE_DISK_GB:?set the measured disk floor in the stack file}"
[[ "$LOOM_MAX_RUNNING_WORKSPACES" =~ ^[1-9][0-9]*$ ]] &&
  [[ "$LOOM_MIN_FREE_DISK_GB" =~ ^[1-9][0-9]*$ ]] || {
  echo 'Workspace cap and disk floor must be positive integers' >&2; exit 1
}
output() { terraform -chdir="$LOOM_INFRA_DIR" output -raw "$1"; }
REGION=$(output region)
[ "$REGION" = "$AWS_REGION" ] || { echo 'State Region and stack Region differ' >&2; exit 1; }
INSTANCE=$(output instance_id)
BUCKET=$(output artifact_bucket)
DATA_VOLUME=$(output data_volume_id)
[[ "$DATA_VOLUME" =~ ^vol-[a-f0-9]+$ ]] || { echo 'Invalid data volume in Terraform state' >&2; exit 1; }
RUNTIME=$(output workspace_container_runtime)
RUNNER_HOSTNAME=$(output hostname)
[ "$RUNNER_HOSTNAME" = "$TF_VAR_hostname" ] || { echo 'State hostname and stack hostname differ; plan first' >&2; exit 1; }
case "$RUNTIME" in runc|kata) ;; *) echo 'Invalid workspace runtime' >&2; exit 1;; esac
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
if [ -n "$TAG" ]; then
  source "$LOOM_INFRA_DIR/release.sh"
  fetch_release "$TAG" "$STAGING"
  RELEASE="$(date -u +%Y%m%d-%H%M%S)-$TAG"
else
  [ -z "$(git status --porcelain)" ] || { echo 'Deployment requires a clean working tree; commit the reviewed release first' >&2; exit 1; }
  RELEASE="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
  pnpm build
  # Packaging uses this build and an empty output directory, so an old desktop cannot be shipped.
  pnpm exec electron-builder --mac --arm64 --config.directories.output="$STAGING/desktop"
  mkdir -p "$STAGING/download"
  find "$STAGING/desktop" -maxdepth 1 -name '*.dmg' -exec cp '{}' "$STAGING/download/Loom.dmg" \;
  [ -s "$STAGING/download/Loom.dmg" ] || { echo 'The desktop package was not built' >&2; exit 1; }
  printf '%s\n' "$RELEASE" >"$STAGING/download/release.txt"
  ARCHIVE="$STAGING/$RELEASE.tgz"
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE" \
    package.json pnpm-lock.yaml pnpm-workspace.yaml out/main/runner.js out/main/restore-check.js out/main/transport-proof.js out/main/chunks \
    images/workspace images/workspace-kata infra/kata \
    infra/host/setup.sh infra/host/prepare.sh infra/host/configure.sh infra/host/host-record.mjs \
    infra/host/transport-proof.sh infra/host/monitoring.sh infra/host/snapshot-age.sh infra/host/loom-workspace.apparmor infra/host/restore-host.sh \
    -C "$STAGING" download
fi
ARCHIVE_SHA256=$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f 1)
aws s3 cp --only-show-errors --region "$REGION" "$ARCHIVE" "s3://$BUCKET/releases/$RELEASE.tgz"
# Values are shell-escaped; the SSM command contains no OAuth or operator secrets.
remote_env() { printf 'export %s=%q\n' "$1" "$2"; }
REMOTE="$(
  remote_env LOOM_STACK_NAME "$STACK_NAME"
  remote_env LOOM_HOSTNAME "$RUNNER_HOSTNAME"
  remote_env LOOM_REGION "$REGION"
  remote_env LOOM_PARAMETER_PREFIX "$LOOM_PARAMETER_PREFIX"
  remote_env LOOM_DATA_VOLUME_ID "$DATA_VOLUME"
  remote_env LOOM_RELEASE "/opt/loom/releases/$RELEASE"
  remote_env LOOM_RELEASE_ID "$RELEASE"
  remote_env LOOM_WORKSPACE_CONTAINER_RUNTIME "$RUNTIME"
  remote_env LOOM_MAX_RUNNING_WORKSPACES "$LOOM_MAX_RUNNING_WORKSPACES"
  remote_env LOOM_MIN_FREE_DISK_GB "$LOOM_MIN_FREE_DISK_GB"
  remote_env LOOM_PREPARE_HOST "$([ "$MODE" = --prepare ] && echo 1 || echo 0)"
  remote_env LOOM_MONITORING_ENABLED "$([ -n "${TF_VAR_alarm_email:-}" ] && echo 1 || echo 0)"
  cat <<SCRIPT
set -euo pipefail
umask 0022
export PATH="\$PATH:/snap/bin"
command -v aws >/dev/null || snap install aws-cli --classic >/dev/null
[ ! -e /opt/loom/releases/$RELEASE ] || { echo 'Release directory already exists' >&2; exit 1; }
install -d -m 0755 /opt/loom/releases/$RELEASE
aws s3 cp --only-show-errors --region $REGION s3://$BUCKET/releases/$RELEASE.tgz /opt/loom/releases/$RELEASE/release.tgz
printf '%s  %s\n' '$ARCHIVE_SHA256' '/opt/loom/releases/$RELEASE/release.tgz' | sha256sum -c - >/dev/null
tar --no-same-owner --no-same-permissions -xzf /opt/loom/releases/$RELEASE/release.tgz -C /opt/loom/releases/$RELEASE
rm /opt/loom/releases/$RELEASE/release.tgz
bash /opt/loom/releases/$RELEASE/infra/host/setup.sh
SCRIPT
)"
ONLINE=None
for _ in $(seq 60); do
  ONLINE=$(aws ssm describe-instance-information --region "$REGION" --filters "Key=InstanceIds,Values=$INSTANCE" \
    --query 'InstanceInformationList[0].PingStatus' --output text)
  [ "$ONLINE" != Online ] || break
  sleep 5
done
[ "$ONLINE" = Online ] || { echo 'Host did not report to Systems Manager' >&2; exit 1; }
ENCODED=$(printf '%s' "$REMOTE" | base64 | tr -d '\n')
COMMAND=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "Loom release $RELEASE" \
  --parameters "$(jq -n --arg run "echo $ENCODED | base64 -d | bash" '{commands:[$run],executionTimeout:["1800"]}')" \
  --query Command.CommandId --output text)
echo "Release $RELEASE is being set up on $INSTANCE."
STATUS=Pending
RESULT='{}'
for _ in $(seq 360); do
  if RESULT=$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND" \
    --instance-id "$INSTANCE" --output json 2>"$STAGING/error"); then
    STATUS=$(jq -r .Status <<<"$RESULT")
    [[ "$STATUS" = Pending || "$STATUS" = InProgress || "$STATUS" = Delayed ]] || break
  elif ! grep -q InvocationDoesNotExist "$STAGING/error"; then
    cat "$STAGING/error" >&2; exit 1
  fi
  sleep 5
done
jq -r '.StandardOutputContent // ""' <<<"$RESULT" | tail -n 40
if [ "$STATUS" != Success ]; then
  jq -r '.StandardErrorContent // ""' <<<"$RESULT" | tail -n 40 >&2
  echo "The release failed on the host ($STATUS)." >&2
  exit 1
fi
curl -fsS --max-time 20 "https://$RUNNER_HOSTNAME/healthz" >/dev/null
printf 'Ready: https://%s/download\n' "$RUNNER_HOSTNAME"
