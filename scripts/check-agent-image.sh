#!/usr/bin/env bash
# Checks a built agent image against a Docker daemon: it prints its usage, refuses to start unpaired, and exits 1 when
# its control plane cannot be reached. The image's exit codes are the contract, so a broken entrypoint fails here.
#   docker build -f Dockerfile.agent -t minibox-agent:ci . && scripts/check-agent-image.sh minibox-agent:ci
#   PLATFORM=linux/arm64 scripts/check-agent-image.sh minibox-agent:ci-arm64
set -euo pipefail

IMAGE="${1:-minibox-agent:ci}"
PLATFORM_FLAG=()
if [ -n "${PLATFORM:-}" ]; then PLATFORM_FLAG=(--platform "$PLATFORM"); fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_exit() {
  local want="$1"
  shift
  local got=0
  docker run --rm "${PLATFORM_FLAG[@]}" "$IMAGE" "$@" >/dev/null 2>&1 || got=$?
  [ "$got" -eq "$want" ] || fail "expected exit $want from \`agent $*\`, got $got"
  echo "ok: exit $want from \`agent $*\`"
}

usage="$(docker run --rm "${PLATFORM_FLAG[@]}" "$IMAGE" --help)" || fail "--help did not exit 0"
grep -q "^Usage: bun src/agent/main.ts" <<<"$usage" || fail "--help did not print the usage"
echo "ok: --help prints the usage"

# No code and no identity: the agent says how to pair and exits 2.
expect_exit 2
# Nothing listens on port 9 inside the container, so the pairing cannot reach the control plane.
expect_exit 1 --server http://127.0.0.1:9 --pair ABCDE-FGHJK

echo "agent image checks passed: $IMAGE"
