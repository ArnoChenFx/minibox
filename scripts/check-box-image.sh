#!/usr/bin/env bash
# Build the base template and check it against a real Docker daemon:
#   - standard profile capabilities: the dev user can write /workspace and use sudo
#   - strict profile (no-new-privileges, no capabilities): sudo is refused
#   - boxes on the isolated box network cannot reach each other; an open network is the control
# Requires docker and bun (the capability list is read from src/docker/hardening.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-minibox-template:base}"
OPEN_NET="minibox-check-open"
ISOLATED_NET="minibox-check-isolated"
SERVER="minibox-check-server"

cleanup() {
  docker rm -f "$SERVER" >/dev/null 2>&1 || true
  docker network rm "$OPEN_NET" "$ISOLATED_NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

docker build -t "$TAG" "$ROOT/templates/base"

mapfile -t CAPS < <(bun -e "import { STANDARD_CAPS } from \"$ROOT/src/docker/hardening.ts\"; for (const c of STANDARD_CAPS) console.log(c);")
CAP_FLAGS=()
for cap in "${CAPS[@]}"; do CAP_FLAGS+=("--cap-add=$cap"); done

docker run --rm --cap-drop=ALL "${CAP_FLAGS[@]}" "$TAG" sh -c 'test "$(id -un)" = dev && touch /workspace/.check && sudo -n true' \
  || fail "standard profile: dev user, /workspace or sudo does not work"
echo "ok: standard profile (dev user, /workspace, sudo)"

if docker run --rm --cap-drop=ALL --security-opt=no-new-privileges "$TAG" sudo -n true >/dev/null 2>&1; then
  fail "strict profile: sudo still works"
fi
echo "ok: strict profile refuses sudo"

docker network create "$OPEN_NET" >/dev/null
docker network create --opt com.docker.network.bridge.enable_icc=false "$ISOLATED_NET" >/dev/null
docker run -d --name "$SERVER" --network "$OPEN_NET" "$TAG" python3 -m http.server 8000 >/dev/null
docker network connect "$ISOLATED_NET" "$SERVER"

open_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$OPEN_NET\").IPAddress}}" "$SERVER")"
isolated_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$ISOLATED_NET\").IPAddress}}" "$SERVER")"

reachable() {
  docker run --rm --network "$1" "$TAG" curl -fsS -m 3 -o /dev/null "http://$2:8000/" >/dev/null 2>&1
}

for _ in $(seq 1 20); do reachable "$OPEN_NET" "$open_ip" && break; sleep 1; done
reachable "$OPEN_NET" "$open_ip" || fail "control: boxes on an open network cannot reach each other"
if reachable "$ISOLATED_NET" "$isolated_ip"; then
  fail "isolated network: a box can reach another box"
fi
echo "ok: isolated network blocks box-to-box traffic (open network is reachable)"
