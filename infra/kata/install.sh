#!/usr/bin/env bash
# Opt-in host preparation. Run on a disposable Ubuntu host before enabling Kata workspaces.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo 'This installation is pinned for x86_64' >&2; exit 1; }
modprobe kvm_intel
modprobe vhost_vsock
modprobe vhost_net
[ -c /dev/kvm ] || { echo 'Nested virtualization and /dev/kvm are required' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl jq zstd >/dev/null
STAGING=$(mktemp -d)
trap 'rm -rf -- "$STAGING"' EXIT
SHA=1463a2b86845f4d3d8e87f2f764ec59856fc0fee3520967a79ade32762be2e97
if [ ! -x /opt/kata/runtime-rs/bin/containerd-shim-kata-v2 ] || \
  [ "$(cat /opt/kata/.loom-release-sha256 2>/dev/null || true)" != "$SHA" ]; then
  curl --fail --location --retry 3 --silent --show-error \
    https://github.com/kata-containers/kata-containers/releases/download/4.3.1/kata-static-4.3.1-amd64.tar.zst \
    -o "$STAGING/kata.tar.zst"
  printf '%s  %s\n' "$SHA" "$STAGING/kata.tar.zst" | sha256sum --check --status
  tar --zstd -xf "$STAGING/kata.tar.zst" -C /
  printf '%s\n' "$SHA" >/opt/kata/.loom-release-sha256
fi
BASE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml
[ -f "$BASE" ] || { echo 'Pinned Kata QEMU configuration is missing' >&2; exit 1; }
CONFIG=/etc/kata-containers/loom-qemu.toml
mkdir -p /etc/docker /etc/modules-load.d /etc/kata-containers
# Kernel release strings are not an identity contract. Mark our explicit guest profile instead.
sed -E 's/^(kernel_params[[:space:]]*=[[:space:]]*)"(.*)"/\1"\2 loom.workspace=kata"/' "$BASE" >"$CONFIG"
grep -q 'loom.workspace=kata' "$CONFIG" || { echo 'Guest boot marker was not configured' >&2; exit 1; }
printf 'kvm_intel\nvhost_vsock\nvhost_net\n' >/etc/modules-load.d/loom-kata.conf
if [ -e /etc/docker/daemon.json ]; then
  cp -p /etc/docker/daemon.json "$STAGING/daemon.json"
else
  printf '{}\n' >"$STAGING/daemon.json"
fi
jq --arg config "$CONFIG" \
  '.runtimes.kata = {runtimeType:"/opt/kata/runtime-rs/bin/containerd-shim-kata-v2",options:{ConfigPath:$config}}' \
  "$STAGING/daemon.json" >"$STAGING/next.json"
dockerd --validate --config-file "$STAGING/next.json"
install -m 0644 "$STAGING/next.json" /etc/docker/daemon.json
systemctl reload docker
docker info --format '{{json .Runtimes}}' | jq -e 'has("kata")' >/dev/null
printf 'Kata 4.3.1 with runtime-rs/QEMU registered; default runtime unchanged\n'
