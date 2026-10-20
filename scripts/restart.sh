#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  setsid sudo nohup dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 < /dev/null &
  sleep 3
  sudo chmod 666 /var/run/docker.sock || true
fi

pkill -f "bun .*minibox/index.ts" 2>/dev/null || true
sleep 1
setsid nohup bun "$ROOT/index.ts" > "$ROOT/server.log" 2>&1 < /dev/null &
echo "minibox pid=$!"

opentunnel up || true
opentunnel status || true
