#!/usr/bin/env bash
#
# Deploys the rtl-improved backend on the home server.
#
#   ./docker.sh            pull, rebuild, restart, follow logs
#   ./docker.sh --no-pull  rebuild from the working tree as-is
#
# The container is reached only through a Cloudflare Tunnel, so the port is
# bound to loopback rather than published to the network. Nothing else should be
# able to talk to it directly — which is also what makes trusting
# CF-Connecting-IP for the per-client connection limit safe.
#
# Settings live in server/deploy.env (gitignored) so that changing them never
# leaves the working tree dirty and blocks the next pull. Example:
#
#   ALLOW_ORIGIN=https://rtl-improved.pages.dev,https://rtl.example.com
#   PORT=8080
#
set -euo pipefail

cd "$(dirname "$0")"

CONFIG_FILE="server/deploy.env"
[ -f "$CONFIG_FILE" ] && . "./$CONFIG_FILE"

IMAGE="${IMAGE:-rtl-improved-backend}"
CONTAINER="${CONTAINER:-rtld}"
PORT="${PORT:-8080}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
DATA_DIR="${DATA_DIR:-data}"
# Must name the front end. Left as "*" this server is open for anyone to use as
# their own free backend.
ALLOW_ORIGIN="${ALLOW_ORIGIN:-*}"
MAX_CONNECTIONS="${MAX_CONNECTIONS:-500}"
MAX_PER_CLIENT="${MAX_PER_CLIENT:-20}"
LOG_LEVEL="${LOG_LEVEL:-info}"

# Docker reads a bare relative path in --volume as the name of a *managed
# volume*, not as a directory, so "data" would quietly put the database inside
# Docker's own storage while leaving an empty data/ in the repo. Anchor anything
# relative to the repo root instead, which is where it reads as pointing.
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$PWD/$DATA_DIR" ;;
esac

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$1" >&2; }
die() { printf '\033[31merror: %s\033[0m\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon"

if [ "$ALLOW_ORIGIN" = "*" ]; then
  warn "ALLOW_ORIGIN is '*' — set it in $CONFIG_FILE to your Pages domain"
fi

# 1. Latest changes.
if [ "${1:-}" != "--no-pull" ]; then
  say "Pulling latest changes"
  if [ -n "$(git status --porcelain)" ]; then
    warn "working tree is dirty; pulling anyway"
  fi
  git pull --ff-only
else
  say "Skipping pull (--no-pull)"
fi

# 2. Build before touching the running container, so a broken build leaves the
#    current deployment up rather than taking the service down with it.
say "Building $IMAGE"
docker build -t "$IMAGE" ./server

# 3. Replace the running container.
say "Replacing $CONTAINER"
if [ -n "$(docker ps -aq -f "name=^${CONTAINER}$")" ]; then
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null
  echo "removed the previous container"
else
  echo "nothing was running"
fi

# 4. Start. The data directory is owned by the invoking user and the container
#    runs as that same uid, so the mount needs no chown and the binary needs no
#    passwd entry — it is statically linked.
mkdir -p "$DATA_DIR"

say "Starting $CONTAINER on ${BIND_ADDR}:${PORT} (database in $DATA_DIR)"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 512m \
  --publish "${BIND_ADDR}:${PORT}:8080" \
  --volume "${DATA_DIR}:/data" \
  "$IMAGE" \
  -addr :8080 \
  -db /data/rtld.db \
  -allow-origin "$ALLOW_ORIGIN" \
  -trust-proxy \
  -max-connections "$MAX_CONNECTIONS" \
  -max-per-client "$MAX_PER_CLIENT" \
  -log-level "$LOG_LEVEL" >/dev/null

# 5. Confirm it actually came up before settling into the log stream, so a
#    crash-on-boot is reported as one rather than as silence.
say "Waiting for health"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://${BIND_ADDR}:${PORT}/healthz" >/dev/null 2>&1; then
    echo "healthy"
    break
  fi
  if [ -z "$(docker ps -q -f "name=^${CONTAINER}$")" ]; then
    say "Container exited during startup"
    docker logs "$CONTAINER"
    die "$CONTAINER failed to start"
  fi
  sleep 1
done

say "Logs (ctrl-c to stop following; the container keeps running)"
exec docker logs -f "$CONTAINER"
