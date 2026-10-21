#!/usr/bin/env bash
# Checks a built base template against a real Docker daemon: the dev user and uid convention, sudo, tools, mount
# points, cache variables, the PATH of login shells, whether containers sharing one volume can read and write it, and
# how each box profile (docs/design.md §14) treats capabilities, no-new-privileges, sudo and ping.
#   bun run build:template && scripts/check-box-image.sh
#   PLATFORM=linux/arm64 scripts/check-box-image.sh minibox-template:base-arm64
set -euo pipefail

TAG="${1:-minibox-template:base}"
RUN_ID="minibox-check-$$"
BOX="$RUN_ID-box"
VOLUME="$RUN_ID-workspace"

cleanup() {
  docker rm -f "$BOX" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

docker_run() {
  if [[ -n "${PLATFORM:-}" ]]; then
    docker run --platform "$PLATFORM" "$@"
  else
    docker run "$@"
  fi
}

in_box() {
  docker_run --rm "$TAG" sh -c "$1"
}

image_label() {
  docker image inspect --format "{{index .Config.Labels \"$1\"}}" "$TAG"
}

if [[ -n "${PLATFORM:-}" ]]; then
  arch="$(docker image inspect --format '{{.Architecture}}' "$TAG")"
  [[ "$arch" == "${PLATFORM#linux/}" ]] || fail "$TAG is $arch, expected ${PLATFORM#linux/}"
fi

[[ "$(docker image inspect --format '{{.Config.User}}' "$TAG")" == "dev" ]] || fail "image USER is not dev"
[[ "$(docker image inspect --format '{{json .Config.Cmd}}' "$TAG")" == '["sleep","infinity"]' ]] \
  || fail "CMD is not sleep infinity"
for pair in minibox.template:true minibox.template.user:dev minibox.template.uid:1000 minibox.template.gid:1000; do
  key="${pair%%:*}"
  want="${pair#*:}"
  got="$(image_label "$key")"
  [[ "$got" == "$want" ]] || fail "label $key is '$got', expected '$want'"
done
echo "ok: image USER dev, CMD sleep infinity, labels record uid/gid 1000"

identity="$(in_box 'echo "$(id -un) $(id -u) $(id -g) $(uname -m)"')"
[[ "$identity" == "dev 1000 1000 "* ]] || fail "default user is '$identity', expected 'dev 1000 1000 ...'"
echo "ok: default user is dev (uid 1000, gid 1000) on $(echo "$identity" | cut -d' ' -f4)"

in_box 'sudo -n true' >/dev/null 2>&1 || fail "sudo -n does not work for dev"
[[ "$(in_box 'sudo -n id -u' 2>/dev/null)" == "0" ]] || fail "sudo does not reach root"
echo "ok: passwordless sudo"

in_box 'for t in git curl python3 gcc make ps tmux jq rg ssh unzip less vim.tiny ping socat; do
  command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }
done' || fail "a required tool is missing"
echo "ok: git curl python3 gcc make ps tmux jq rg ssh unzip less vim.tiny ping socat are installed"
in_box 'test -x /usr/lib/openssh/sftp-server' || fail "openssh-sftp-server is missing, so the SSH sftp subsystem cannot run"
echo "ok: /usr/lib/openssh/sftp-server is installed for the SSH sftp subsystem"

in_box 'test -O /workspace && test -w /workspace && test -O /home/dev && test -O /home/dev/.cache' \
  || fail "a writable mount point is missing or not owned by dev"
in_box 'test -d /opt/minibox/tools/bin && ! test -w /opt/minibox/tools/bin' \
  || fail "/opt/minibox/tools/bin is missing or writable by dev (the tools volume is read-only)"
echo "ok: /workspace, /home/dev and /home/dev/.cache belong to dev; /opt/minibox/tools/bin exists and is read-only for dev"

expected_env='/home/dev/.npm-global
/home/dev/.cache
/home/dev/.cache/npm
/home/dev/.cache/pip
/home/dev/.cache/yarn'
actual_env="$(in_box 'for k in NPM_CONFIG_PREFIX XDG_CACHE_HOME npm_config_cache PIP_CACHE_DIR YARN_CACHE_FOLDER; do printenv "$k"; done')"
[[ "$actual_env" == "$expected_env" ]] || fail "cache and prefix variables are: $(echo "$actual_env" | tr '\n' ' ')"
echo "ok: NPM_CONFIG_PREFIX, XDG_CACHE_HOME, npm_config_cache, PIP_CACHE_DIR and YARN_CACHE_FOLDER point under /home/dev"

docker_run -d --name "$BOX" "$TAG" >/dev/null
[[ "$(docker exec "$BOX" id -un)" == "dev" ]] || fail "docker exec does not enter as dev"
login="$(docker exec "$BOX" bash -l -c 'echo "$(id -un) $PATH"')"
[[ "${login%% *}" == "dev" ]] || fail "login shell does not run as dev: $login"
path="${login#* }"
[[ ":$path:" == *":/opt/minibox/tools/bin:"* && ":$path:" == *":/home/dev/.npm-global/bin:"* ]] \
  || fail "login shell PATH lost the box entries: $path"
echo "ok: docker exec and the login shell used by the web terminal run as dev, with the box PATH"

docker volume create "$VOLUME" >/dev/null
docker_run --rm -v "$VOLUME:/workspace" "$TAG" sh -c \
  'echo from-first > /workspace/shared.txt && mkdir /workspace/second' \
  || fail "a fresh volume mounted at /workspace is not writable by dev"
docker_run --rm -v "$VOLUME:/workspace" "$TAG" sh -c \
  'echo from-second >> /workspace/shared.txt && touch /workspace/second/by-second' \
  || fail "a second container cannot write to the shared volume"
owners="$(docker_run --rm -v "$VOLUME:/workspace" "$TAG" sh -c \
  'stat -c "%u:%g" /workspace/shared.txt /workspace/second /workspace/second/by-second' | sort -u)"
[[ "$owners" == "1000:1000" ]] || fail "files in the shared volume are owned by: $(echo "$owners" | tr '\n' ' ')"
echo "ok: two containers sharing one volume read and write it; every file is owned by 1000:1000"

# The flags mirror src/box-profile.ts; tests/template.test.ts keeps the capability list in step with it.
standard_flags=(--cap-drop ALL)
for cap in AUDIT_WRITE CHOWN DAC_OVERRIDE FOWNER FSETID KILL NET_BIND_SERVICE NET_RAW SETFCAP SETGID SETUID; do
  standard_flags+=(--cap-add "$cap")
done
strict_flags=(--cap-drop ALL --security-opt no-new-privileges:true)
relaxed_flags=()

# Arguments: profile, expected CapBnd, expected NoNewPrivs, expected sudo and ping (ok|fail), then docker run flags.
check_profile() {
  local name="$1" cap_bnd="$2" no_new_privs="$3" sudo_want="$4" ping_want="$5"
  shift 5
  local state sudo_got ping_got=""
  state="$(docker_run --rm "$@" "$TAG" sh -c 'grep -E "^(CapBnd|NoNewPrivs):" /proc/self/status | cut -f2 | tr "\n" " "')"
  [[ "$state" == "$cap_bnd $no_new_privs " ]] || fail "$name profile: CapBnd and NoNewPrivs are '$state'"
  if docker_run --rm "$@" "$TAG" sudo -n true >/dev/null 2>&1; then sudo_got=ok; else sudo_got=fail; fi
  [[ "$sudo_got" == "$sudo_want" ]] || fail "$name profile: sudo is $sudo_got, expected $sudo_want"
  # File capabilities are not applied to binaries run under QEMU, so ping is only checked on the native platform.
  if [[ -z "${PLATFORM:-}" ]]; then
    if docker_run --rm "$@" "$TAG" ping -c 1 -W 2 127.0.0.1 >/dev/null 2>&1; then ping_got=ok; else ping_got=fail; fi
    [[ "$ping_got" == "$ping_want" ]] || fail "$name profile: ping is $ping_got, expected $ping_want"
  fi
  echo "ok: $name profile: CapBnd $cap_bnd, NoNewPrivs $no_new_privs, sudo $sudo_got, ping ${ping_got:-not checked under emulation}"
}
check_profile standard 00000000a00024fb 0 ok ok "${standard_flags[@]}"
check_profile strict 0000000000000000 1 fail fail "${strict_flags[@]}"
check_profile relaxed 00000000a80425fb 0 ok ok "${relaxed_flags[@]}"

echo "all box image checks passed for $TAG"
