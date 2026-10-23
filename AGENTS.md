# Agent instructions

## Bun

- MiniBox requires Bun 1.4.4 or later (`engines.bun` in `package.json`).
- Never lower `engines.bun` or `@types/bun`, and keep `"typecheck": "bun check --no-script"`. Do not switch the typecheck back to `tsc`.
- If your local `bun --version` is older, run `bun upgrade` before `bun install` and `bun run check`.

## Cursor Cloud specific instructions

`.cursor/environment.json` runs `.cursor/install.sh` during each Build. It upgrades Bun to the latest release, checks it against `engines.bun` and runs `bun install --frozen-lockfile`.
