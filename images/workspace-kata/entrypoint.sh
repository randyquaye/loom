#!/usr/bin/env bash
set -euo pipefail
# Fail closed when this service image is accidentally launched under the host's kernel.
grep -qw 'loom.workspace=kata' /proc/cmdline \
  || { echo 'This image requires the Loom Kata guest profile' >&2; exit 1; }
STATE=/var/lib/loom-docker-state
STORE=/var/lib/loom-docker
DISK="$STATE/docker.ext4"
mountpoint -q "$DISK" || { echo 'Persistent workspace Docker disk must be mounted' >&2; exit 1; }
[ ! -L "$DISK" ] || { echo 'Docker disk cannot be a symlink' >&2; exit 1; }
[ "$(blkid -p -s TYPE -o value "$DISK")" = ext4 ] \
  || { echo 'Persistent Docker disk must already contain ext4' >&2; exit 1; }
# Docker delegates networking and cgroups inside this VM. These mounts belong to the
# guest kernel, so making them writable grants no access to the host's kernel settings.
mount -o remount,rw /proc/sys
mount -o remount,rw /sys/fs/cgroup
[ -b /dev/loop-control ] || [ -c /dev/loop-control ] || mknod /dev/loop-control c 10 237
for n in $(seq 0 7); do [ -b "/dev/loop$n" ] || mknod "/dev/loop$n" b 7 "$n"; done
mkdir -p "$STORE"
mount -o loop,noatime "$DISK" "$STORE"
# Keep all inner Docker state on the same ext4 filesystem. Explicitly select the classic
# backend: Docker 29's separate containerd image store must not escape persistent storage.
dockerd --host unix:///var/run/docker.sock --group loom \
  --data-root "$STORE/docker" --storage-driver overlay2 \
  --feature containerd-snapshotter=false --shutdown-timeout 20 \
  --bip 172.28.0.1/16 --default-address-pool base=172.29.0.0/16,size=24 &
DAEMON=$!
shutdown_docker() {
  trap - TERM INT
  kill -TERM "$DAEMON" 2>/dev/null || true
  wait "$DAEMON" || true
  sync
  umount "$STORE"
}
trap shutdown_docker TERM INT
wait "$DAEMON"
