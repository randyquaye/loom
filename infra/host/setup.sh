#!/usr/bin/env bash
# Stage a release, then activate it. Routine releases do not run host maintenance.
set -euo pipefail
exec 9>/run/loom-deploy.lock
flock -n 9 || { echo 'Another Loom deployment is running' >&2; exit 1; }
: "${LOOM_HOSTNAME:?}"
: "${LOOM_REGION:?}"
: "${LOOM_DATA_VOLUME_ID:?}"
: "${LOOM_RELEASE:?}"
: "${LOOM_RELEASE_ID:?}"
DATA_DIR=/var/lib/loom
CONFIG_DIR=/etc/loom
RUNNER_PORT=3877
LOGIN_PROXY_PORT=3878
CLAUDE_FRONT_PORT=8443
CODEX_FRONT_PORT=8444
step() { printf '\n== %s\n' "$1"; }
operator_status() {
  [ -f "$CONFIG_DIR/operator.token" ] || return 1
  printf 'Authorization: Bearer %s\n' "$(cat "$CONFIG_DIR/operator.token")" |
    curl -fsS --max-time 10 -H @- "http://127.0.0.1:$RUNNER_PORT/admin/drain"
}
# A release restarts the runner and stops containers. The operator must drain first.
if systemctl is-active --quiet loom-runner; then
  operator_status | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("draining") is True else 1)' || {
    echo 'Drain the runner before deploying; inspect its active work before cutting it over' >&2; exit 1;
  }
fi
if [ ! -f "$CONFIG_DIR/prepared" ] || [ "${LOOM_PREPARE_HOST:-0}" = 1 ]; then
  bash "$LOOM_RELEASE/infra/host/prepare.sh"
fi
mountpoint -q "$DATA_DIR" || { echo 'The data disk is not mounted' >&2; exit 1; }
WORKSPACE_RUNTIME=${LOOM_WORKSPACE_CONTAINER_RUNTIME:-runc}
WORKSPACE_PIDS=512
RUNNER_MOUNTS=$DATA_DIR
case "$WORKSPACE_RUNTIME" in
  runc) ;;
  kata)
    docker info --format '{{json .Runtimes}}' | jq -e 'has("kata")' >/dev/null || {
      echo 'Kata is not installed; drain and deploy with --prepare' >&2; exit 1;
    }
    WORKSPACE_PIDS=2048
    LOGIN_FILES_VIEW=$DATA_DIR/login-files-view
    sudo -u loom mkdir -p "$DATA_DIR/login-files"
    mkdir -p "$LOGIN_FILES_VIEW"
    grep -q " $LOGIN_FILES_VIEW " /etc/fstab ||
      echo "$DATA_DIR/login-files $LOGIN_FILES_VIEW none bind,ro,nofail 0 0" >>/etc/fstab
    mountpoint -q "$LOGIN_FILES_VIEW" || mount "$LOGIN_FILES_VIEW"
    findmnt -no VFS-OPTIONS "$LOGIN_FILES_VIEW" | grep -qE '(^|,)ro(,|$)' || {
      echo 'The login files view is not read-only' >&2; exit 1;
    }
    RUNNER_MOUNTS="$DATA_DIR $LOGIN_FILES_VIEW"
    ;;
  *) echo 'LOOM_WORKSPACE_CONTAINER_RUNTIME must be runc or kata' >&2; exit 1;;
esac
export WORKSPACE_PIDS
bash "$LOOM_RELEASE/infra/host/configure.sh"
step "Release"
# Preserve the privileged publisher before any user-writable dependency installation.
PUBLISHER="$CONFIG_DIR/transport-publisher/$LOOM_RELEASE_ID"
install -d -m 0755 -o root -g root "$CONFIG_DIR/transport-publisher" "$PUBLISHER" "$PUBLISHER/chunks"
install -m 0644 -o root -g root "$LOOM_RELEASE/out/main/transport-proof.js" "$PUBLISHER/transport-proof.js"
cp -R "$LOOM_RELEASE/out/main/chunks/." "$PUBLISHER/chunks/"
chown -R root:root "$PUBLISHER"
chmod -R go-w "$PUBLISHER"
# Only dependency output is writable by loom; root-run code and every ancestor stay protected.
install -d -m 0755 -o loom -g loom "$LOOM_RELEASE/node_modules"
sudo -u loom -H sh -c "cd '$LOOM_RELEASE' && pnpm install --prod --frozen-lockfile --reporter=append-only" | tail -n 5
node --check "$LOOM_RELEASE/out/main/runner.js"
docker build --quiet --tag "loom-workspace:$LOOM_RELEASE_ID" \
  --build-arg LOOM_UID="$(id -u loom)" --build-arg LOOM_GID="$(id -g loom)" \
  "$LOOM_RELEASE/images/workspace"
if [ "$WORKSPACE_RUNTIME" = kata ]; then
  docker build --quiet --tag "loom-workspace-kata:$LOOM_RELEASE_ID" \
    --build-arg "WORKSPACE_IMAGE=loom-workspace:$LOOM_RELEASE_ID" "$LOOM_RELEASE/images/workspace-kata"
fi
if [ "${LOOM_MONITORING_ENABLED:-0}" = 1 ]; then
  bash "$LOOM_RELEASE/infra/host/monitoring.sh"
fi
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
ln -sfn "$LOOM_RELEASE" /opt/loom/current
mv "$CONFIG_DIR/runner.env.next" "$CONFIG_DIR/runner.env"
install -m 0644 "$DRAFT" /etc/caddy/Caddyfile
rm -f "$DRAFT"
# The bridge only exists once Docker is up, and the proxy cannot listen on it before then.
install -d /etc/systemd/system/caddy.service.d
printf '[Unit]\nAfter=docker.service\nWants=docker.service\n' >/etc/systemd/system/caddy.service.d/after-docker.conf
systemctl daemon-reload
systemctl enable --quiet caddy
systemctl reload-or-restart caddy
bash "$LOOM_RELEASE/infra/host/transport-proof.sh"

step "Runner service"
cat >/etc/systemd/system/loom-runner.service <<UNIT
[Unit]
Description=Loom runner
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
# Without the data disk the runner would start an empty Loom on the root disk.
RequiresMountsFor=$RUNNER_MOUNTS
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

systemctl enable --quiet loom-runner
systemctl restart loom-runner
for _ in $(seq 180); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$RUNNER_PORT/healthz" >/dev/null; then
    echo "Release $LOOM_RELEASE_ID is ready. Matching desktop: https://$LOOM_HOSTNAME/download"
    exit 0
  fi
  sleep 2
done
echo 'Runner did not become ready; inspect journalctl -u loom-runner' >&2
exit 1
