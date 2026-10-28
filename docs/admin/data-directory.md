# Data directory

MiniBox keeps the state it owns in its data directory, `DATA_DIR`. The directory holds plain files and two embedded SQLite databases for the event log and for tasks. MiniBox is not a database server, so back up this directory. See [Backups](backups.md).

The default location is `./data` in a source checkout, and `/data` in the release image. Relative paths resolve from the project root. `~/` expands to your home directory.

| Path | Mode | Contents |
|---|---|---|
| `access_key` | `600` | The access key, written on first start when none is set in the environment or in `.env` |
| `sessions.json` | `600` | Browser sign-ins, written on first sign-in. Stores SHA-256 hashes of the session tokens, never the tokens. Also stores a scrypt check of the access key, so every session ends when the key changes. |
| `tokens.json` | `600` | Agent API tokens, written on first token create. Stores SHA-256 hashes only, with the token's scopes, limits and expiry. Rotating `ACCESS_KEY` does not revoke these tokens. |
| `self-tokens.json` | `600` | The self token of each box that has one, as the SHA-256 hash, the box id and name. Written when a token is issued, revoked or renamed with its box. |
| `questions.json` | `600` | Questions that box agents asked, with their options and answers. It keeps up to 500 questions and drops the oldest answered ones first. Written when a question is asked or answered. |
| `ssh_host_ed25519_key` | `600` | The SSH gateway's host key, generated when the server starts. `minibox ssh-config` pins its public half. |
| `boxes/` | `700` | One box spec per file, `<id>.json`, mode `600`. This is where box settings live. |
| `checkpoints/` | `700` | One checkpoint record per file, `ck_….json`, mode `600`. A recycle bin entry is a record here too, with a `trash` field. The data itself is in the checkpoint repository volume. |
| `checkpoints/schedules/` | `700` | One checkpoint schedule per box, `<box id>.json`, mode `600`. It holds the rule with its time zone, the next run and the last run. A box without a file has no schedule. It survives a restart. |
| `packages/` | `700` | Checkpoint packages, `<id>.mbckpt`, mode `600`, each with a `<id>.json` record beside it. A package is sealed with the passphrase it was exported with. The hourly sweep removes it once it is 24 hours old. |
| `backups/` | `700` | Stored backups, `<id>.mbbak`, mode `600`, each with a `<id>.json` record beside it. A backup is sealed with the passphrase it was made with. Backups pulled from an off-site target are kept here too. Not included in a backup. `BACKUP_DIR` moves this folder, and with it every backup, elsewhere; the old folder is then no longer read. See [Backups](backups.md#where-backups-are-kept). |
| `targets.json` | `600` | Off-site targets: name, kind, address, folder, the pinned SFTP host key and the last sync. It never holds a credential. Written when you add the first target. See [Backups](backups.md#off-site-targets). |
| `exec/` | `700` | Saved output of `exec` commands, one JSON file per command. |
| `secrets/` | `700` | Host secrets in `env/<name>`, mode `600`, each created when you set a secret. The credentials of off-site targets are among them, as `env/target.<id>.<field>`. Notification channel secrets in `notify/<channel id>`, and webhook URLs in `notify/<channel id>.url`, mode `600`. Also `checkpoint-repo.key`, mode `600`, created when the checkpoint repository is first initialized. |
| `tools.d/` | `700` | Custom tool catalog entries, one `<id>.json` file each, mode `600`, created when you save a custom tool |
| `hosts.json` | `600` | Hosts: ID, name, endpoint without any credential, the SSH host key fingerprint, when each host was added, and the labels an `auto` create may select it by. Written when you add the first remote host, when a host's labels change, and when `HOST_LABELS` gives the local host labels. The local host's own record holds only its labels. |
| `hosts/<id>/` | `700` | Credential files for each remote host, mode `600`: `ca.pem`, `cert.pem` and `key.pem` for `tcp://`, or `ssh_key` for `ssh://`. The API never returns them. |
| `agents.json` | `600` | Paired host agents: ID, public key, version, pairing and revocation times. Written when an agent pairs. It never holds a private key, which stays in the agent's own data volume. See [Agent](../reference/agent.md). |
| `volumes/` | `700` | One volume record per file, `vol_….json`, mode `600`. |
| `pools.json` | `600` | Storage pools and the role defaults, written when you change pool settings. If the file is missing, MiniBox uses the local pool. A corrupt file is left in place and treated as missing. |
| `notify.json` | `600` | Notification channels: name, type, notices, box filter and endpoint, such as an ntfy topic or a Telegram chat id. Written when you save a channel. Their secrets and webhook URLs are in `secrets/notify/`. See [Notifications](../user-guide/notifications.md). |
| `events.db`, `events.db-wal`, `events.db-shm` | | The event log, an SQLite database in WAL mode, opened when the server starts. See [Security](security.md) for what it records. |
| `tasks.db`, `tasks.db-wal`, `tasks.db-shm` | | Task status, and the newest 64 KB of each task's output, opened when the server starts. |
| `cli/` | `700` | Cached CLI binaries the server builds on first download request, under `<version>-<hash>/` with a `.sha256` sidecar, plus `runtimes/` for Bun runtimes used to compile them. |

At startup, MiniBox creates `DATA_DIR` and the folders `boxes/`, `checkpoints/`, `exec/`, `secrets/` and `volumes/`, and tightens any mode that is looser than listed. Other paths appear when their feature first runs. MiniBox never writes `.env`.

## Keep the key safe

If `DATA_DIR` is lost, and no key is set in `.env` or the environment, the next start generates a new access key. Everyone must then sign in with the new key. To avoid this, keep a copy of `access_key`, or set `ACCESS_KEY` in `.env`.

## Copying the databases

Stop MiniBox before you copy `events.db` or `tasks.db`. In WAL mode, recent changes stay in the `-wal` file until SQLite writes them to the main file. Copying the main file alone can give you a stale copy. To copy the data directory while MiniBox runs, use [Backups](backups.md), which copies the databases from a consistent snapshot.
