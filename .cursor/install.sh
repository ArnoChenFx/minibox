#!/usr/bin/env bash
# Cursor cloud agent install step. MiniBox needs the Bun version in package.json engines.bun
# (bun check --no-script), so bring Bun up to the latest release before installing dependencies.
set -euo pipefail

sudo=""
if [ "$(id -u)" -ne 0 ]; then sudo="sudo -n"; fi

# The Bun installer and `bun upgrade` both need unzip.
if ! command -v unzip >/dev/null 2>&1; then
  $sudo apt-get update -qq && $sudo apt-get install -y -qq unzip
fi

if command -v bun >/dev/null 2>&1; then
  bun upgrade || $sudo "$(command -v bun)" upgrade
else
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  # Non-login shells may not read ~/.bashrc, where the installer adds ~/.bun/bin.
  $sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun 2>/dev/null || true
fi

bun --version
bun -e 'const want = require("./package.json").engines.bun;
if (!Bun.semver.satisfies(Bun.version, want)) {
  console.error(`Bun ${Bun.version} does not satisfy engines.bun ${want}`);
  process.exit(1);
}'
bun install --frozen-lockfile
