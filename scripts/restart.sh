#!/usr/bin/env bash
# Restart MiniBox on a host without systemd: ensure dockerd, restart the Bun server, ensure the tunnel.
# Usage: scripts/restart.sh [--no-tunnel]
#
# Single-user sandbox convenience, not a deployment script. It starts dockerd with sudo and gives the Docker socket to
# your primary group only (mode 660). Docker access is root-equivalent, so do not use this on a shared host.
# Logs are appended to, never truncated.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/server.log"
# Ask the server's own loader for PORT and the key location, so this script agrees with the running server.
CONFIG="$(bun -e 'const { loadConfig } = await import("./src/config.ts"); const { accessKeyPath } = await import("./src/data-dir.ts"); const c = loadConfig(); console.log([c.port, c.accessKeySource, accessKeyPath(c.dataDir)].join("\t"));')"
IFS=$'\t' read -r PORT KEY_SOURCE KEY_FILE <<<"$CONFIG"

# Socket access goes to the caller's primary group (mode 660). That group is already in this shell's credentials, so the
# server started below reaches Docker without a re-login. A new supplementary group (docker) would not apply here.
grant_docker_socket() {
  sudo chgrp "$(id -gn)" /var/run/docker.sock && sudo chmod 660 /var/run/docker.sock
}

# 1. Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "[restart] starting dockerd"
  # Markers are best effort: a log this user cannot write must not stop the restart.
  printf -- '--- %s dockerd start\n' "$(date -Is)" >> /tmp/dockerd.log || true
  setsid sudo nohup dockerd --host=unix:///var/run/docker.sock >> /tmp/dockerd.log 2>&1 < /dev/null &
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; grant_docker_socket 2>/dev/null || true; sleep 1; done
fi
grant_docker_socket || echo "[restart] could not give the Docker socket to group $(id -gn); check sudo" >&2
docker info --format 'docker {{.ServerVersion}}' 

# 2. Base template (first run only)
if ! docker image inspect minibox-template:base >/dev/null 2>&1; then
  echo "[restart] building base template"
  bun run build:template
fi

# 3. Bun server (graceful SIGTERM, then wait for the port to free up)
if pkill -TERM -f "bun .*${ROOT}/src/server.ts" 2>/dev/null; then
  for _ in $(seq 1 20); do pgrep -f "bun .*${ROOT}/src/server.ts" >/dev/null || break; sleep 0.25; done
fi
setsid nohup bun "$ROOT/src/server.ts" >> "$LOG" 2>&1 < /dev/null &
echo "[restart] minibox pid=$!"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo
case "$KEY_SOURCE" in
  env) echo "[restart] ACCESS_KEY comes from the environment" ;;
  env-file) echo "[restart] ACCESS_KEY comes from .env" ;;
  data-dir) echo "[restart] ACCESS_KEY is read from $KEY_FILE" ;;
  generated) echo "[restart] generated ACCESS_KEY is stored in $KEY_FILE (mode 600); .env was not changed" ;;
esac

# 4. OpenTunnel (no systemd here, so run the foreground service detached)
if [[ "${1:-}" != "--no-tunnel" ]] && command -v opentunnel >/dev/null; then
  if ! pgrep -f "opentunnel (serve|up)" >/dev/null; then
    echo "[restart] starting opentunnel"
    printf -- '--- %s opentunnel start\n' "$(date -Is)" >> /tmp/opentunnel.log || true
    setsid nohup opentunnel serve >> /tmp/opentunnel.log 2>&1 < /dev/null &
    sleep 2
  fi
  opentunnel status || true
fi
