#!/bin/sh
# Installs the MiniBox CLI from the server that sent this script:
#   curl -fsSL <origin>/cli/install.sh | sh
# The server fills in its own address below. The binary is checked against the server's sha256 list before it is
# installed. MINIBOX_INSTALL_DIR chooses the folder (default ~/.local/bin). No root access is needed.

set -eu

MINIBOX_ORIGIN="__MINIBOX_ORIGIN__"

die() {
  printf 'minibox install: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v awk >/dev/null 2>&1 || die "awk is required"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "this script installs on Linux and macOS. On Windows, run: irm $MINIBOX_ORIGIN/cli/install.ps1 | iex" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "there is no MiniBox CLI for $(uname -m)" ;;
esac
# An Intel shell running under Rosetta on an Apple silicon Mac takes the native build.
if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

name="minibox-$os-$arch"
dir="${MINIBOX_INSTALL_DIR:-$HOME/.local/bin}"
target="$dir/minibox"
mkdir -p "$dir" || die "cannot create $dir"
download="$dir/.minibox-download.$$"
trap 'rm -f "$download"' EXIT

status=$(curl -sS --connect-timeout 15 -o "$download" -w '%{http_code}' "$MINIBOX_ORIGIN/cli/$name") ||
  die "could not reach $MINIBOX_ORIGIN"
if [ "$status" != 200 ]; then
  reason=$(head -c 400 "$download" 2>/dev/null || true)
  die "$MINIBOX_ORIGIN answered HTTP $status for $name: $reason"
fi

sums=$(curl -fsS --connect-timeout 15 "$MINIBOX_ORIGIN/cli/checksums.txt") ||
  die "could not fetch the checksums from $MINIBOX_ORIGIN"
expected=$(printf '%s\n' "$sums" | awk -v name="$name" '$2 == name { print $1; exit }')
[ -n "$expected" ] || die "the server lists no checksum for $name"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$download" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$download" | awk '{ print $1 }')
else
  die "sha256sum or shasum is required to check the download"
fi
if [ "$actual" != "$expected" ]; then
  die "checksum mismatch for $name (expected $expected, got $actual). Nothing was installed."
fi

chmod 755 "$download"
mv -f "$download" "$target"

version=$("$target" --version </dev/null 2>/dev/null) ||
  die "$target was installed, but it does not run on this machine"
printf 'Installed %s (%s)\n' "$target" "$version"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    # shellcheck disable=SC2016
    printf '\n%s is not on your PATH yet. Add this line to your shell profile, then open a new shell:\n  export PATH="%s:$PATH"\n' "$dir" "$dir"
    ;;
esac

printf '\nSet up SSH with an access key, or an agent token that has the box:ssh scope:\n  MINIBOX_URL=%s MINIBOX_ACCESS_KEY=<token> minibox ssh-config --append\n' "$MINIBOX_ORIGIN"
