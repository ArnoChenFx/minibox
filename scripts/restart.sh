#!/usr/bin/env bash
# Restart MiniBox on a host without systemd: ensure dockerd, restart the Bun server, ensure the tunnel.
# Usage: scripts/restart.sh [--no-tunnel]
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/server.log"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-3920}"

# 1. Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "[restart] starting dockerd"
  setsid sudo nohup dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 < /dev/null &
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sudo chmod 666 /var/run/docker.sock 2>/dev/null || true; sleep 1; done
  sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
fi
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

# 4. OpenTunnel (no systemd here, so run the foreground service detached)
if [[ "${1:-}" != "--no-tunnel" ]] && command -v opentunnel >/dev/null; then
  if ! pgrep -f "opentunnel (serve|up)" >/dev/null; then
    echo "[restart] starting opentunnel"
    setsid nohup opentunnel serve > /tmp/opentunnel.log 2>&1 < /dev/null &
    sleep 2
  fi
  opentunnel status || true
fi
