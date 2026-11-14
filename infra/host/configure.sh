#!/usr/bin/env bash
# Stage and verify settings before replacing the running release's environment.
set -euo pipefail
: "${LOOM_REGION:?}"
: "${LOOM_HOSTNAME:?}"
: "${LOOM_PARAMETER_PREFIX:?}"
: "${LOOM_RELEASE:?}"
: "${LOOM_RELEASE_ID:?}"
: "${LOOM_MAX_RUNNING_WORKSPACES:?set the measured host cap in the stack file}"
: "${LOOM_MIN_FREE_DISK_GB:?set the measured disk floor in the stack file}"
[[ "$LOOM_PARAMETER_PREFIX" =~ ^/[a-z][a-z0-9-]{0,16}$ ]] || exit 1
[[ "$LOOM_MAX_RUNNING_WORKSPACES" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$LOOM_MIN_FREE_DISK_GB" =~ ^[1-9][0-9]*$ ]] || exit 1
CONFIG_DIR=/etc/loom
install -d -m 0750 -o root -g loom "$CONFIG_DIR"
STAGING=$(mktemp -d "$CONFIG_DIR/preflight.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
# Only ParameterNotFound means absent. Access and network failures stop deployment.
parameter() {
  local name=$1 optional=${2:-no}
  if aws ssm get-parameter --region "$LOOM_REGION" --name "$LOOM_PARAMETER_PREFIX/$name" \
    --with-decryption --query Parameter.Value --output text 2>"$STAGING/error"; then
    return 0
  fi
  if grep -q 'ParameterNotFound' "$STAGING/error"; then
    if [ "$optional" = yes ]; then return 3; fi
    echo "Missing $LOOM_PARAMETER_PREFIX/$name; run settings.sh first" >&2
  else
    echo "Could not read $LOOM_PARAMETER_PREFIX/$name; the running service was not changed" >&2
    cat "$STAGING/error" >&2
  fi
  return 1
}
# No OAuth secret is accepted as a multiline EnvironmentFile directive.
read_setting() {
  local name=$1 value
  value=$(parameter "$name") || return 1
  [ -n "$value" ] && [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "Empty or multiline setting: $name" >&2; return 1;
  }
  printf '%s' "$value"
}
GOOGLE_CLIENT_ID=$(read_setting google-client-id)
GOOGLE_CLIENT_SECRET=$(read_setting google-client-secret)
SIGN_IN_DOMAINS=$(read_setting sign-in-domains)
OWNER_EMAIL=$(read_setting owner-email)
GITHUB_CLIENT_ID=$(read_setting github-client-id)
GITHUB_CLIENT_SECRET=$(read_setting github-client-secret)
GITHUB_APP_SLUG=$(read_setting github-app-slug)
[[ "$GOOGLE_CLIENT_ID" = *.apps.googleusercontent.com ]] || { echo 'Invalid Google client id' >&2; exit 1; }
[[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || { echo 'Invalid owner email' >&2; exit 1; }
[[ "$GITHUB_APP_SLUG" =~ ^[a-zA-Z0-9-]+$ ]] || { echo 'Invalid GitHub App slug' >&2; exit 1; }
# Never replace either key. Recovery must match any existing local copy.
recover_key() {
  local name=$1 file=$2 value result
  if value=$(parameter "$name" yes); then
    printf '%s\n' "$value" >"$STAGING/key"
    if [ -f "$file" ] && [ "$(cat "$file")" != "$value" ]; then
      echo "$name differs from its recovery copy; refusing to replace either" >&2; exit 1
    fi
    install -m 0640 -o root -g loom "$STAGING/key" "$file"
  else
    result=$?
    [ "$result" = 3 ] || exit 1
    if [ ! -f "$file" ]; then
      if [ "$name" = secret-key ]; then openssl rand -base64 32 >"$STAGING/key"
      else openssl genpkey -algorithm ED25519 -out "$STAGING/key"; fi
      install -m 0640 -o root -g loom "$STAGING/key" "$file"
    fi
    aws ssm put-parameter --region "$LOOM_REGION" --name "$LOOM_PARAMETER_PREFIX/$name" \
      --type SecureString --value "file://$file" --no-overwrite >/dev/null
  fi
}
recover_key secret-key "$CONFIG_DIR/secret.key"
recover_key runner-signing-key "$CONFIG_DIR/runner-signing.pem"
node - "$CONFIG_DIR/secret.key" <<'JS'
const fs = require('node:fs')
const value = fs.readFileSync(process.argv[2], 'utf8').trim()
const key = Buffer.from(value, 'base64')
if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid vault recovery key')
JS
node "$LOOM_RELEASE/infra/host/host-record.mjs" "$LOOM_HOSTNAME" "$CONFIG_DIR/runner-signing.pem" "$SIGN_IN_DOMAINS"
# Operator credential authorizes drain/status only; it never enters an SSM command or output.
if [ ! -f "$CONFIG_DIR/operator.token" ]; then
  (umask 077 && openssl rand -hex 32 >"$CONFIG_DIR/operator.token")
fi
# The runner reads this through its environment, not through a world-readable file.
OPERATOR_TOKEN=$(cat "$CONFIG_DIR/operator.token")
[[ "$OPERATOR_TOKEN" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid local operator token' >&2; exit 1; }
AVAILABLE=$(df --output=avail -B1 /var/lib/loom | tail -n 1 | tr -d ' ')
[ "$AVAILABLE" -ge "$((LOOM_MIN_FREE_DISK_GB * 1024 * 1024 * 1024))" ] || {
  echo 'Data disk is below the configured free-space floor' >&2; exit 1;
}
[ -f "$LOOM_RELEASE/out/main/runner.js" ] && [ -f "$LOOM_RELEASE/out/main/transport-proof.js" ] && [ -s "$LOOM_RELEASE/download/Loom.dmg" ] || {
  echo 'Release is missing the runner or matching desktop' >&2; exit 1;
}
env_line() {
  local value=$2
  value=${value//\\/\\\\}; value=${value//\"/\\\"}
  printf '%s="%s"\n' "$1" "$value" >>"$STAGING/runner.env"
}
# Write the candidate file without evaluating values as shell code.
while IFS='=' read -r name value; do env_line "$name" "$value"; done <<ENV
LOOM_DATA_DIR=/var/lib/loom
LOOM_SECRET_KEY=$(cat "$CONFIG_DIR/secret.key")
LOOM_RUNNER_HOST=127.0.0.1
LOOM_RUNNER_PORT=3877
LOOM_WORKSPACE_PLACEMENT=container
LOOM_WORKSPACE_CONTAINER_RUNTIME=${LOOM_WORKSPACE_CONTAINER_RUNTIME:-runc}
LOOM_WORKSPACE_IMAGE=loom-workspace:$LOOM_RELEASE_ID
LOOM_WORKSPACE_KATA_IMAGE=loom-workspace-kata:$LOOM_RELEASE_ID
LOOM_WORKSPACE_DOCKER_DISK_GB=${LOOM_WORKSPACE_DOCKER_DISK_GB:-16}
LOOM_WORKSPACE_APPARMOR=loom-workspace
LOOM_WORKSPACE_IDLE_MINUTES=${LOOM_WORKSPACE_IDLE_MINUTES:-30}
LOOM_WORKSPACE_MEMORY=${LOOM_WORKSPACE_MEMORY:-4g}
LOOM_WORKSPACE_CPUS=${LOOM_WORKSPACE_CPUS:-2}
LOOM_WORKSPACE_PIDS=${WORKSPACE_PIDS:-512}
LOOM_MAX_RUNNING_WORKSPACES=$LOOM_MAX_RUNNING_WORKSPACES
LOOM_MIN_FREE_DISK_GB=$LOOM_MIN_FREE_DISK_GB
LOOM_LOGIN_PROXY_PORT=3878
LOOM_CLAUDE_FRONT_URL=https://$LOOM_HOSTNAME:8443
LOOM_CODEX_FRONT_URL=https://$LOOM_HOSTNAME:8444
LOOM_GITHUB_FRONT_URL=https://$LOOM_HOSTNAME
LOOM_PUBLIC_URL=https://$LOOM_HOSTNAME
LOOM_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
LOOM_GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
LOOM_SIGN_IN_DOMAINS=$SIGN_IN_DOMAINS
LOOM_OWNER_EMAIL=$OWNER_EMAIL
LOOM_GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
LOOM_GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
LOOM_GITHUB_APP_SLUG=$GITHUB_APP_SLUG
LOOM_RUNNER_SIGNING_KEY_FILE=$CONFIG_DIR/runner-signing.pem
LOOM_TRANSPORT_PROOF_FILE=$CONFIG_DIR/transport-proof.json
LOOM_OPERATOR_TOKEN=$OPERATOR_TOKEN
LOOM_DOWNLOAD_DIR=$LOOM_RELEASE/download
LOOM_RELEASE_ID=$LOOM_RELEASE_ID
ENV
install -m 0640 -o root -g loom "$STAGING/runner.env" "$CONFIG_DIR/runner.env.next"
