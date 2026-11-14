#!/usr/bin/env bash
# Print a prefilled registration link for an app owned by the company's GitHub org.
set -euo pipefail
source "$(dirname "$0")/stack.sh"
load_stack "${1:?Usage: github-app.sh STACK GITHUB_ORG}"
ORG=${2:?Usage: github-app.sh STACK GITHUB_ORG}
[[ "$ORG" =~ ^[a-zA-Z0-9-]+$ ]] || { echo 'Invalid GitHub org name' >&2; exit 1; }
node - "$TF_VAR_hostname" "$ORG" <<'JS'
const [host, org] = process.argv.slice(2)
const query = new URLSearchParams({
  name: `Loom ${org}`, description: 'Connect your Loom cloud workspaces to selected repositories.',
  url: `https://${host}`, 'callback_urls[]': `https://${host}/auth/github/callback`,
  request_oauth_on_install: 'false', public: 'false', webhook_active: 'false',
  contents: 'write', pull_requests: 'write', metadata: 'read'
})
console.log(`https://github.com/organizations/${org}/settings/apps/new?${query}`)
JS
