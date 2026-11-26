#!/usr/bin/env bash
# Prompt once for each org setting; credentials bypass Terraform and command arguments.
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: settings.sh STACK}"
STAGING=$(mktemp -d)
chmod 700 "$STAGING"
trap 'rm -rf "$STAGING"' EXIT
ask() {
  local name=$1 label=$2 type=$3 value
  if [ "$type" = SecureString ]; then
    read -r -s -p "$label: " value
    printf '\n' >&2
  else
    read -r -p "$label: " value
  fi
  [ -n "$value" ] && [ "${#value}" -le 4096 ] && [[ "$value" != *$'\r'* && "$value" != *$'\n'* ]] || {
    echo 'A nonempty, single-line value under 4096 characters is required' >&2; exit 1;
  }
  case "$name" in
    sign-in-mode) [[ "$value" = company || "$value" = managed ]] || exit 1;;
    google-client-id) [[ "$value" = *.apps.googleusercontent.com ]] || exit 1;;
    owner-email) [[ "$value" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || exit 1;;
    sign-in-domains)
      value=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
      [[ "$value" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(,[a-z0-9]([a-z0-9.-]*[a-z0-9])?)*$ ]] || exit 1;;
    github-app-slug) [[ "$value" =~ ^[a-zA-Z0-9-]+$ ]] || exit 1;;
  esac
  (umask 077 && printf '%s' "$value" >"$STAGING/$name")
  printf '%s\t%s\n' "$name" "$type" >>"$STAGING/types"
}
ask google-client-id 'Google OAuth client ID' String
ask google-client-secret 'Google OAuth client secret' SecureString
ask sign-in-mode 'Sign-in mode: company or managed' String
if [ "$(cat "$STAGING/sign-in-mode")" = company ]; then
  ask sign-in-domains 'Allowed Workspace domains, comma separated' String
fi
ask owner-email 'First owner email, used only before the org exists' String
ask github-client-id 'GitHub App client ID' String
ask github-client-secret 'GitHub App client secret' SecureString
ask github-app-slug 'GitHub App slug' String
# All input is checked before the first write. A failed AWS write exits without deploying.
while IFS=$'\t' read -r name type; do
  aws ssm put-parameter --region "$AWS_REGION" --name "$LOOM_PARAMETER_PREFIX/$name" --type "$type" \
    --value "file://$STAGING/$name" --overwrite >/dev/null
  aws ssm get-parameter --region "$AWS_REGION" --name "$LOOM_PARAMETER_PREFIX/$name" \
    --query Parameter.Name --output text >/dev/null
done <"$STAGING/types"
echo 'Settings saved. Redeploy the drained runner to activate them.'
