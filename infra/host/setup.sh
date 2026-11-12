#!/usr/bin/env bash
# Makes an Ubuntu machine into the Loom pilot host and puts one release of the runner on it.
# Runs on the host, as root, from infra/host/deploy.sh. Every step checks before it acts, so
# running it again is how the host is updated.
set -euo pipefail

: "${LOOM_HOSTNAME:?the DNS name people reach the runner at}"
: "${LOOM_REGION:?the AWS Region the host is in}"
: "${LOOM_DATA_VOLUME_ID:?the id of the data disk}"
: "${LOOM_RELEASE:?the folder this release was unpacked into}"

DATA_DIR=/var/lib/loom
CONFIG_DIR=/etc/loom
RUNNER_PORT=3877
# Agent logins: the runner's proxy, and the HTTPS front that containers reach it through.
LOGIN_PROXY_PORT=3878
# Each program has an address of its own on that front. GitHub's is the ordinary HTTPS port.
CLAUDE_FRONT_PORT=8443
CODEX_FRONT_PORT=8444
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n== %s\n' "$1"; }

step "Packages"
# Quiet on purpose: Systems Manager keeps only the start of a command's output.
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential ca-certificates curl docker.io gh git gnupg openssl python3 >/dev/null

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

step "Release"
chown -R loom:loom "$LOOM_RELEASE"
sudo -u loom -H sh -c "cd '$LOOM_RELEASE' && pnpm install --prod --frozen-lockfile --reporter=append-only" | tail -n 5
# The container user carries the runner's own numbers: both write the same checkout.
docker build --quiet --tag loom-workspace:latest \
  --build-arg LOOM_UID="$(id -u loom)" --build-arg LOOM_GID="$(id -g loom)" \
  "$LOOM_RELEASE/images/workspace"
# Ubuntu's default profile for containers refuses the mounts Codex's sandbox makes.
install -m 0644 "$LOOM_RELEASE/infra/host/loom-workspace.apparmor" /etc/apparmor.d/loom-workspace
apparmor_parser --replace /etc/apparmor.d/loom-workspace
ln -sfn "$LOOM_RELEASE" /opt/loom/current
# Three releases are kept: this one and two to go back to. Their names start with the time.
find /opt/loom/releases -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +4 | xargs -r rm -rf

step "Settings"
install -d -m 0750 -o root -g loom "$CONFIG_DIR"
# The key that encrypts what the runner stores lives here, off the data disk, so a
# snapshot of the data disk alone reveals nothing.
if [ ! -f "$CONFIG_DIR/secret.key" ]; then
  (umask 027 && openssl rand -base64 32 >"$CONFIG_DIR/secret.key")
fi
setting() {
  aws ssm get-parameter --region "$LOOM_REGION" --name "/loom/$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true
}
GOOGLE_CLIENT_ID="$(setting google-client-id)"
(
  umask 027
  cat >"$CONFIG_DIR/runner.env" <<ENV
LOOM_DATA_DIR=$DATA_DIR
LOOM_SECRET_KEY=$(cat "$CONFIG_DIR/secret.key")
LOOM_RUNNER_HOST=127.0.0.1
LOOM_RUNNER_PORT=$RUNNER_PORT
LOOM_WORKSPACE_PLACEMENT=container
LOOM_WORKSPACE_APPARMOR=loom-workspace
LOOM_LOGIN_PROXY_PORT=$LOGIN_PROXY_PORT
LOOM_CLAUDE_FRONT_URL=https://$LOOM_HOSTNAME:$CLAUDE_FRONT_PORT
LOOM_CODEX_FRONT_URL=https://$LOOM_HOSTNAME:$CODEX_FRONT_PORT
LOOM_GITHUB_FRONT_URL=https://$LOOM_HOSTNAME
LOOM_PUBLIC_URL=https://$LOOM_HOSTNAME
LOOM_GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
LOOM_GOOGLE_CLIENT_SECRET=$(setting google-client-secret)
LOOM_SIGN_IN_DOMAINS=$(setting sign-in-domains)
LOOM_PILOT_EMAILS=$(setting pilot-emails)
LOOM_GITHUB_CLIENT_ID=$(setting github-client-id)
LOOM_GITHUB_CLIENT_SECRET=$(setting github-client-secret)
LOOM_GITHUB_APP_SLUG=$(setting github-app-slug)
ENV
)
chgrp loom "$CONFIG_DIR/secret.key" "$CONFIG_DIR/runner.env"

step "TLS proxy"
# Port 80 is closed, so the certificate is proven over 443 alone and nothing redirects.
#
# The sites after the first are for containers only. They listen on the Docker bridge
# address, which is reachable from this machine's containers and from nowhere else, under
# the same public certificate; containers are told the host's name leads there. So an agent
# talks HTTPS to a name it already trusts, and no private certificate is put into any
# container. Each program has a port of its own, and its name is put in front of the path
# here, because a program cannot be relied on to keep one: Codex makes its model call at the
# host and port it is given and drops the rest. The caller's address is set here too, from
# the connection itself, whatever the caller wrote in its headers.
BRIDGE="$(ip -4 addr show docker0 | awk '/inet /{print $2}' | cut -d/ -f1)"
[ -n "$BRIDGE" ] || { echo "Docker's bridge has no address" >&2; exit 1; }
# To a container, the host's name on the ordinary port stands for GitHub: git and gh are
# pointed at it, and the login proxy passes them on as the workspace's owner. Containers are
# told from the internet by the address they call from, which only this machine's own
# containers can have. (gh will not match a host that has a port, hence the ordinary one.)
BRIDGE_SUBNET="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Subnet}}')"
[ -n "$BRIDGE_SUBNET" ] || { echo "Docker's bridge has no subnet" >&2; exit 1; }
# Written aside and checked first: a file Caddy cannot read must never become its settings.
DRAFT="$(mktemp)"
cat >"$DRAFT" <<CADDY
{
	auto_https disable_redirects
	cert_issuer acme {
		disable_http_challenge
	}
}

$LOOM_HOSTNAME {
	@containers remote_ip $BRIDGE_SUBNET
	handle @containers {
		rewrite * /github{uri}
		reverse_proxy 127.0.0.1:$LOGIN_PROXY_PORT {
			header_up X-Forwarded-For {remote_host}
		}
	}
	handle {
		reverse_proxy 127.0.0.1:$RUNNER_PORT
	}
}

https://$LOOM_HOSTNAME:$CLAUDE_FRONT_PORT {
	bind $BRIDGE
	rewrite * /claude{uri}
	reverse_proxy 127.0.0.1:$LOGIN_PROXY_PORT {
		header_up X-Forwarded-For {remote_host}
	}
}

https://$LOOM_HOSTNAME:$CODEX_FRONT_PORT {
	bind $BRIDGE
	rewrite * /codex{uri}
	reverse_proxy 127.0.0.1:$LOGIN_PROXY_PORT {
		header_up X-Forwarded-For {remote_host}
	}
}
CADDY
caddy validate --config "$DRAFT" --adapter caddyfile >/dev/null 2>&1 ||
  { caddy validate --config "$DRAFT" --adapter caddyfile 2>&1 | grep '"error"' | cut -c1-300 >&2; exit 1; }
install -m 0644 "$DRAFT" /etc/caddy/Caddyfile
rm -f "$DRAFT"
# The bridge only exists once Docker is up, and the proxy cannot listen on it before then.
install -d /etc/systemd/system/caddy.service.d
printf '[Unit]\nAfter=docker.service\nWants=docker.service\n' >/etc/systemd/system/caddy.service.d/after-docker.conf
systemctl daemon-reload
systemctl enable --quiet caddy
systemctl reload-or-restart caddy

step "Runner service"
cat >/etc/systemd/system/loom-runner.service <<UNIT
[Unit]
Description=Loom runner
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
# Without the data disk the runner would start an empty Loom on the root disk.
RequiresMountsFor=$DATA_DIR
ConditionPathIsMountPoint=$DATA_DIR

[Service]
User=loom
Group=loom
EnvironmentFile=$CONFIG_DIR/runner.env
WorkingDirectory=/opt/loom/current
ExecStart=/usr/bin/node out/main/runner.js
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
if [ -z "$GOOGLE_CLIENT_ID" ]; then
  # Without sign-in the runner would hand out a developer token. Not on the internet.
  systemctl disable --quiet --now loom-runner || true
  echo "Sign-in is not set up (/loom/google-client-id is missing): the runner is NOT running."
else
  systemctl enable --quiet loom-runner
  systemctl restart loom-runner
  sleep 3
  systemctl is-active loom-runner
fi
