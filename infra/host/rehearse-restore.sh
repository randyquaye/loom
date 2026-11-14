#!/usr/bin/env bash
# Read-only by default. --apply restores to disposable infrastructure, verifies, and removes it.
# Usage: infra/host/rehearse-restore.sh STACK snap-0123456789abcdef0 [--apply]
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: rehearse-restore.sh STACK SNAPSHOT_ID [--plan|--apply]}"
cd "$LOOM_INFRA_DIR/../.."
SNAPSHOT="${2:-}"
MODE="${3:---plan}"
[[ "$SNAPSHOT" =~ ^snap-[0-9a-f]+$ ]] && [[ "$MODE" = --plan || "$MODE" = --apply ]] || {
  echo 'Usage: rehearse-restore.sh STACK SNAPSHOT_ID [--plan|--apply]' >&2; exit 1;
}
output() { terraform -chdir="$LOOM_INFRA_DIR" output -raw "$1"; }
REGION="$(output region)"
SOURCE_INSTANCE="$(output instance_id)"
SOURCE_VOLUME="$(output data_volume_id)"
BUCKET="$(output artifact_bucket)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
SNAPSHOT_INFO="$(aws ec2 describe-snapshots --region "$REGION" --snapshot-ids "$SNAPSHOT" --output json)"
jq -e --arg volume "$SOURCE_VOLUME" --arg owner "$ACCOUNT" \
  '.Snapshots | length == 1 and (.[0] | .State == "completed" and .Encrypted == true and .VolumeId == $volume and .OwnerId == $owner)' \
  <<<"$SNAPSHOT_INFO" >/dev/null || { echo 'Choose a completed encrypted snapshot of the pilot data volume' >&2; exit 1; }
HOST="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE" --query 'Reservations[0].Instances[0]' --output json)"
ZONE="$(jq -r '.Placement.AvailabilityZone' <<<"$HOST")"
SUBNET="$(jq -r '.SubnetId' <<<"$HOST")"
VPC="$(jq -r '.VpcId' <<<"$HOST")"
AMI="$(jq -r '.ImageId' <<<"$HOST")"
PROFILE_ARN="$(output restore_instance_profile_arn)"
ROOT_DEVICE="$(jq -r '.RootDeviceName' <<<"$HOST")"
# Prove the recovery key exists without retrieving or printing its value on this Mac.
aws ssm get-parameter --region "$REGION" --name "$LOOM_PARAMETER_PREFIX/secret-key" --query Parameter.Name --output text >/dev/null
NAME="loom-restore-$STACK_NAME-$(date -u +%Y%m%d-%H%M%S)-$RANDOM$RANDOM"
EVIDENCE=".context/$NAME"
mkdir -p "$EVIDENCE"
jq -n --arg snapshot "$SNAPSHOT" --arg source "$SOURCE_VOLUME" --arg zone "$ZONE" \
  --arg ami "$AMI" --arg subnet "$SUBNET" --arg key "$LOOM_PARAMETER_PREFIX/secret-key" \
  '{snapshot:$snapshot,sourceVolume:$source,zone:$zone,ami:$ami,subnet:$subnet,
    creates:["one encrypted restored volume","one fresh host","one security group with no inbound access"],
    keyParameter:$key,publicListeners:false,providerRenewal:false,productionChanges:false}' \
  >"$EVIDENCE/plan.json"
cat "$EVIDENCE/plan.json"
if [ "$MODE" = --plan ]; then echo "Plan saved in $EVIDENCE/plan.json. No resources changed."; exit 0; fi

INSTANCE="" VOLUME="" GROUP="" ARCHIVE_KEY=""
ATTEMPTED_INSTANCE=0 ATTEMPTED_VOLUME=0 ATTEMPTED_GROUP=0
record() {
  jq -n --arg name "$NAME" --arg instance "$INSTANCE" --arg volume "$VOLUME" --arg group "$GROUP" --arg archive "$ARCHIVE_KEY" \
    '{name:$name,instance:$instance,volume:$volume,securityGroup:$group,archive:$archive}' >"$EVIDENCE/resources.json"
}
# A request can succeed at AWS even when its response is lost. Recover the new ID from
# this rehearsal's unique tags before deciding cleanup has nothing left to remove.
discover() {
  local found
  for _ in 1 2 3; do
    if found="$(aws "$@")" && [[ "$found" =~ ^(i-|vol-|sg-)[a-zA-Z0-9]+$ ]]; then
      printf '%s' "$found"
      return 0
    fi
    sleep 1
  done
  return 1
}
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  local failed=0
  if [ -z "$INSTANCE" ] && [ "$ATTEMPTED_INSTANCE" = 1 ]; then
    INSTANCE="$(discover ec2 describe-instances --region "$REGION" \
      --filters "Name=tag:Name,Values=$NAME" 'Name=tag:LoomRestore,Values=rehearsal' \
      'Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down' \
      --query 'Reservations[].Instances[].InstanceId | [0]' --output text)" || failed=1
  fi
  if [ -n "$INSTANCE" ] && [ "$INSTANCE" != "$SOURCE_INSTANCE" ]; then
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE" >/dev/null || failed=1
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE" || failed=1
  fi
  if [ -z "$VOLUME" ] && [ "$ATTEMPTED_VOLUME" = 1 ]; then
    VOLUME="$(discover ec2 describe-volumes --region "$REGION" \
      --filters "Name=tag:Name,Values=$NAME" 'Name=tag:LoomRestore,Values=rehearsal' "Name=snapshot-id,Values=$SNAPSHOT" \
      --query 'Volumes[0].VolumeId' --output text)" || failed=1
  fi
  if [ -n "$VOLUME" ] && [ "$VOLUME" != "$SOURCE_VOLUME" ]; then
    aws ec2 delete-volume --region "$REGION" --volume-id "$VOLUME" || failed=1
  fi
  if [ -z "$GROUP" ] && [ "$ATTEMPTED_GROUP" = 1 ]; then
    GROUP="$(discover ec2 describe-security-groups --region "$REGION" \
      --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC" \
      --query 'SecurityGroups[0].GroupId' --output text)" || failed=1
  fi
  record || failed=1
  if [ -n "$GROUP" ]; then aws ec2 delete-security-group --region "$REGION" --group-id "$GROUP" || failed=1; fi
  if [ -n "$ARCHIVE_KEY" ]; then aws s3 rm --only-show-errors --region "$REGION" "s3://$BUCKET/$ARCHIVE_KEY" || failed=1; fi
  if [ "$failed" = 1 ]; then
    echo "Cleanup needs attention: $EVIDENCE/resources.json" >&2
    result=1
  else
    printf '%s\n' 'All disposable resources removed.' >"$EVIDENCE/cleanup.txt"
  fi
  echo "Rehearsal evidence: $EVIDENCE"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pnpm build >"$EVIDENCE/build.log" 2>&1
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$EVIDENCE/release.tgz" \
  package.json pnpm-lock.yaml pnpm-workspace.yaml out/main/runner.js out/main/restore-check.js out/main/chunks \
  infra/host/restore-host.sh
ARCHIVE_KEY="releases/$NAME.tgz"
record
aws s3 cp --only-show-errors --region "$REGION" "$EVIDENCE/release.tgz" "s3://$BUCKET/$ARCHIVE_KEY"
TAGS="$(jq -nc --arg name "$NAME" '[{Key:"Name",Value:$name},{Key:"LoomRestore",Value:"rehearsal"}]')"
ATTEMPTED_GROUP=1
GROUP="$(aws ec2 create-security-group --region "$REGION" --vpc-id "$VPC" --group-name "$NAME" \
  --description 'Disposable Loom restore rehearsal; no inbound access' \
  --tag-specifications "$(jq -nc --argjson tags "$TAGS" '[{ResourceType:"security-group",Tags:$tags}]')" \
  --query GroupId --output text)"
record
ATTEMPTED_VOLUME=1
VOLUME="$(aws ec2 create-volume --region "$REGION" --availability-zone "$ZONE" --snapshot-id "$SNAPSHOT" \
  --volume-type gp3 --encrypted --client-token "$NAME-volume" \
  --tag-specifications "$(jq -nc --argjson tags "$TAGS" '[{ResourceType:"volume",Tags:$tags}]')" \
  --query VolumeId --output text)"
record
[ "$VOLUME" != "$SOURCE_VOLUME" ] || exit 1
aws ec2 wait volume-available --region "$REGION" --volume-ids "$VOLUME"
ATTEMPTED_INSTANCE=1
INSTANCE="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type m7i-flex.large \
  --subnet-id "$SUBNET" --security-group-ids "$GROUP" --associate-public-ip-address \
  --iam-instance-profile "Arn=$PROFILE_ARN" --client-token "$NAME-instance" \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=1' \
  --block-device-mappings "$(jq -nc --arg device "$ROOT_DEVICE" \
    '[{DeviceName:$device,Ebs:{VolumeSize:30,VolumeType:"gp3",Encrypted:true,DeleteOnTermination:true}}]')" \
  --tag-specifications "$(jq -nc --argjson tags "$TAGS" \
    '[{ResourceType:"instance",Tags:$tags},{ResourceType:"volume",Tags:$tags}]')" \
  --query 'Instances[0].InstanceId' --output text)"
record
[ "$INSTANCE" != "$SOURCE_INSTANCE" ] || exit 1
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE"
aws ec2 attach-volume --region "$REGION" --instance-id "$INSTANCE" --volume-id "$VOLUME" --device /dev/sdf >/dev/null
for _ in $(seq 60); do
  ONLINE="$(aws ssm describe-instance-information --region "$REGION" --filters "Key=InstanceIds,Values=$INSTANCE" \
    --query 'InstanceInformationList[0].PingStatus' --output text)"
  [ "$ONLINE" != Online ] || break
  sleep 5
done
[ "$ONLINE" = Online ] || { echo 'Rehearsal host did not report to Systems Manager' >&2; exit 1; }
REMOTE="$(cat <<SCRIPT
set -euo pipefail
export PATH="\$PATH:/snap/bin"
command -v aws >/dev/null || snap install aws-cli --classic >/dev/null
aws s3 cp --only-show-errors --region $REGION s3://$BUCKET/$ARCHIVE_KEY /tmp/loom-restore.tgz
tar -xOf /tmp/loom-restore.tgz infra/host/restore-host.sh >/tmp/loom-restore-host.sh
export LOOM_PARAMETER_PREFIX=$LOOM_PARAMETER_PREFIX
export LOOM_REGION=$REGION LOOM_RESTORED_VOLUME=$VOLUME LOOM_ARTIFACT_BUCKET=$BUCKET
export LOOM_RESTORE_ARCHIVE=$ARCHIVE_KEY LOOM_RESTORE_INSTANCE=$INSTANCE
bash /tmp/loom-restore-host.sh
SCRIPT
)"
ENCODED="$(printf '%s' "$REMOTE" | base64 | tr -d '\n')"
jq -n --arg command "echo $ENCODED | base64 -d | bash" '{commands:[$command],executionTimeout:["1800"]}' >"$EVIDENCE/command.json"
COMMAND="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "file://$EVIDENCE/command.json" --comment "$NAME" --query Command.CommandId --output text)"
printf '%s\n' "$COMMAND" >"$EVIDENCE/command-id"
STATUS=Pending
for _ in $(seq 360); do
  STATUS="$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND" --instance-id "$INSTANCE" \
    --query Status --output text 2>/dev/null || echo Pending)"
  [[ "$STATUS" = Pending || "$STATUS" = InProgress || "$STATUS" = Delayed ]] || break
  sleep 5
done
aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND" --instance-id "$INSTANCE" \
  --output json >"$EVIDENCE/result.json"
jq -r '.StandardOutputContent' "$EVIDENCE/result.json" | tail -n 10
if [ "$STATUS" != Success ] || ! jq -e '.StandardOutputContent | contains("\"restoreVerified\":true")' "$EVIDENCE/result.json" >/dev/null; then
  echo "Restore did not verify. See $EVIDENCE/result.json" >&2
  exit 1
fi
