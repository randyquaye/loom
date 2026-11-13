#!/usr/bin/env bash
# Run on a disposable Linux host after installing Kata and building the workspace image.
# This exercises the same boundaries regardless of the runtime's implementation details.
set -euo pipefail
IMAGE=${LOOM_KATA_IMAGE:-loom-workspace-kata:latest}
ROOT=$(mktemp -d /var/tmp/loom-kata-check.XXXXXX)
NAME=$(basename "$ROOT" | tr '[:upper:].' '[:lower:]-')
A="$NAME-a"
B="$NAME-b"
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    docker exec --user loom "$A" docker ps -a >&2 2>/dev/null || true
    docker exec --user loom "$A" docker logs --tail 60 kata-check-db-1 >&2 2>/dev/null || true
    docker logs --tail 20 "$A" >&2 2>/dev/null || true
    if [ "${LOOM_KATA_KEEP_FAILED:-0}" = 1 ]; then
      printf 'Kept failed workspace %s and data %s for inspection\n' "$A" "$ROOT" >&2
      return
    fi
  fi
  if [ "$status" = 0 ] && [ "${LOOM_KATA_KEEP_FIXTURES:-0}" = 1 ]; then
    printf 'Kept passing workspaces %s %s and data %s for follow-up checks\n' "$A" "$B" "$ROOT"
    return
  fi
  docker rm -f "$A" "$B" >/dev/null 2>&1 || true
  if mountpoint -q "$ROOT/login-files-view"; then umount "$ROOT/login-files-view"; fi
  rm -rf -- "$ROOT"
}
trap cleanup EXIT
pass() { printf 'PASS %s\n' "$1"; }
docker info --format '{{json .Runtimes}}' | jq -e 'has("kata")' >/dev/null
docker image inspect "$IMAGE" >/dev/null
mkdir -p "$ROOT"/{a,b}/{checkout,home,state}
for slot in a b; do
  truncate -s 12G "$ROOT/$slot/state/docker.ext4"
  mkfs.ext4 -q -F -m 0 "$ROOT/$slot/state/docker.ext4"
done
printf 'host-only\n' >"$ROOT/host-only"
# Login files reach a workspace the way the host supplies them: through a view that is
# read-only before Kata sees it. Kata's own read-only mounts do not hold against guest root.
mkdir "$ROOT/login-files" "$ROOT/login-files-view"
printf 'immutable\n' >"$ROOT/login-files/readonly"
mount -o bind,ro "$ROOT/login-files" "$ROOT/login-files-view"
chown -R 1000:1000 "$ROOT/a/home" "$ROOT/b/home" "$ROOT/a/checkout" "$ROOT/b/checkout"
start() {
  local name=$1 slot=$2
  docker run -d --init --name "$name" --runtime kata --memory 3g --cpus 1 \
    --pids-limit 2048 --cap-add SYS_ADMIN --cap-add NET_ADMIN --cap-add SYS_RESOURCE --cap-add SYS_PTRACE \
    --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
    --mount "type=bind,source=$ROOT/$slot/checkout,target=$ROOT/$slot/checkout" \
    --mount "type=bind,source=$ROOT/$slot/home,target=/home/loom" \
    --mount "type=bind,source=$ROOT/$slot/state/docker.ext4,target=/var/lib/loom-docker-state/docker.ext4" \
    --mount "type=bind,source=$ROOT/login-files-view/readonly,target=/home/loom/.readonly,readonly" \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec --user loom "$name" docker info >/dev/null 2>&1; then return; fi
    [ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] || break
    sleep 1
  done
  docker logs "$name" >&2
  return 1
}
inside() { docker exec --user loom --workdir "$ROOT/a/checkout" "$A" "$@"; }
start "$A" a
[ "$(inside id -u)" = 1000 ]
[ "$(inside uname -r)" != "$(uname -r)" ]
inside test ! -e "$ROOT/host-only"
pass 'guest kernel and non-root execution'
inside docker info --format '{{.Driver}}' | grep -Eq '^(overlay2|overlayfs)$'
inside docker version --format '{{.Server.Version}}'
inside docker compose version --short
pass 'private Docker and Compose are ready'
cat >"$ROOT/a/checkout/server.js" <<'JS'
require('node:http').createServer((_q,r)=>r.end('kata-backend')).listen(4101,'0.0.0.0');
JS
cat >"$ROOT/a/checkout/Dockerfile" <<'DOCKER'
FROM node:24-alpine
COPY server.js /server.js
CMD ["node", "/server.js"]
DOCKER
cat >"$ROOT/a/checkout/compose.yaml" <<'YAML'
name: kata-check
services:
  backend:
    build: .
    ports: ["127.0.0.1:4101:4101"]
  frontend:
    image: nginx:1.28-alpine
    ports: ["127.0.0.1:4100:80"]
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes: ["database:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 5s
      retries: 120
volumes:
  database:
YAML
inside docker compose up -d --build --wait
[ "$(inside curl -fsS http://127.0.0.1:4101)" = kata-backend ]
inside curl -fsS http://127.0.0.1:4100 | grep -q 'Welcome to nginx'
inside docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE kata_canary (value text); INSERT INTO kata_canary VALUES ('survives');" >/dev/null
pass 'image builds, Compose networking and committed database writes'
start "$B" b
if docker exec --user loom "$B" docker inspect kata-check-db-1 >/dev/null 2>&1; then
  echo 'another workspace can inspect private containers' >&2; exit 1
fi
inside docker run --rm -v /:/guest alpine:3.22 test ! -e "/guest$ROOT/host-only"
pass 'separate workspace daemons and no host-root access'
# Root inside the VM must not turn the supplied credential mount writable.
if docker exec "$A" sh -c 'echo changed > /home/loom/.readonly' 2>/dev/null; then
  echo 'read-only host file was modified' >&2; exit 1
fi
if docker exec "$A" sh -c 'mount -o remount,rw /home/loom/.readonly 2>/dev/null; echo changed > /home/loom/.readonly' 2>/dev/null; then
  echo 'guest root made the host file writable' >&2; exit 1
fi
[ "$(cat "$ROOT/login-files/readonly")" = immutable ]
pass 'read-only host mount'
FIRST=$(docker inspect --format '{{.Id}}' "$A")
docker stop --time 30 "$A" >/dev/null
docker rm "$A" >/dev/null
start "$A" a
[ "$(docker inspect --format '{{.Id}}' "$A")" != "$FIRST" ]
inside docker compose up -d --wait
[ "$(inside docker compose exec -T db psql -U postgres -Atc 'SELECT value FROM kata_canary')" = survives ]
pass 'images and database survive graceful workspace recreation'
docker kill "$A" >/dev/null
docker rm "$A" >/dev/null
start "$A" a
inside docker compose up -d --wait
[ "$(inside docker compose exec -T db psql -U postgres -Atc 'SELECT value FROM kata_canary')" = survives ]
pass 'database recovers after forced VM termination'
inside docker run --rm alpine:3.22 sh -c 'echo persistent > /tmp/check'
pass 'Docker remains usable after recovery'
