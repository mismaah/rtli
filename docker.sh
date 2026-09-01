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
# The uid:gid the container runs as. Defaults to whoever runs this script, so
# files on the mounted volume stay owned by them and need no root to inspect.
RUN_AS="${RUN_AS:-$(id -u):$(id -g)}"
# SELinux (Fedora, RHEL, Rocky) denies containers access to bind mounts unless
# the directory is relabelled. ":Z" does that for this container's exclusive
# use, and is ignored where SELinux is not enforcing.
VOLUME_OPTS="${VOLUME_OPTS:-Z}"

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

# 4. Prove the container can actually write to the volume before starting it.
#
#    This is worth a throwaway container rather than a shell test, because the
#    ways it fails are ones the host cannot see for itself: a uid that does not
#    line up, SELinux refusing the mount, or rootless Docker remapping the
#    container's user to a subuid that owns nothing. Getting this wrong used to
#    surface as a server that started, reported healthy, and quietly recorded
#    nothing.
mkdir -p "$DATA_DIR"

probe_writable() {
  docker run --rm \
    --user "$RUN_AS" \
    --volume "${DATA_DIR}:/data:${VOLUME_OPTS}" \
    --entrypoint /rtld \
    "$IMAGE" -db /data/.probe.db -check -log-level error
}

cleanup_probe() {
  rm -f "${DATA_DIR}/.probe.db" "${DATA_DIR}/.probe.db-wal" "${DATA_DIR}/.probe.db-shm" 2>/dev/null || true
}

say "Checking the database directory is writable"
if ! probe_writable; then
  # Nearly always ownership, and that is the one cause the host can fix itself.
  echo "not writable as $RUN_AS — taking ownership of $DATA_DIR"
  chown -R "$RUN_AS" "$DATA_DIR" 2>/dev/null \
    || sudo chown -R "$RUN_AS" "$DATA_DIR" \
    || die "could not change ownership of $DATA_DIR"

  if ! probe_writable; then
    cleanup_probe
    printf '\n' >&2
    echo "The container still cannot write to $DATA_DIR. The usual causes:" >&2
    echo "  * SELinux (Fedora, RHEL, Rocky) — VOLUME_OPTS is '${VOLUME_OPTS}';" >&2
    echo "    it should contain Z. Check with: ls -Zd $DATA_DIR" >&2
    echo "  * rootless Docker — the container's user maps to a subuid that owns" >&2
    echo "    nothing on the host. Try RUN_AS=0:0 in server/deploy.env." >&2
    echo "  * a filesystem mounted read-only or with restrictive options." >&2
    die "database directory is not writable by the container"
  fi
fi
cleanup_probe
echo "writable"

say "Starting $CONTAINER on ${BIND_ADDR}:${PORT} (database in $DATA_DIR)"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --user "$RUN_AS" \
  --read-only \
  --tmpfs /tmp \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 512m \
  --publish "${BIND_ADDR}:${PORT}:8080" \
  --volume "${DATA_DIR}:/data:${VOLUME_OPTS}" \
  "$IMAGE" \
  -addr :8080 \
  -db /data/rtld.db \
  -require-store \
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
