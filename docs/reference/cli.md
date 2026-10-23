# CLI reference

The `minibox` command talks to a running MiniBox server. Install it from the server, as described in [SSH access and the command-line tool](../user-guide/ssh-and-cli.md).

```bash
minibox --version
minibox <command> --help
```

`--help` on any command prints its help and exits with code 0.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MINIBOX_URL` | `http://127.0.0.1:3920` | The server's address |
| `MINIBOX_ACCESS_KEY` | none | The access key, or an agent token. Used as the bearer token. |
| `ACCESS_KEY` | none | Used when `MINIBOX_ACCESS_KEY` is not set |
| `MINIBOX_TOOLSETS` | none | Toolsets for `minibox mcp`, such as `core,session` |
| `MINIBOX_BACKUP_PASSPHRASE` | none | The passphrase for `minibox backup` and `minibox restore`. It is never a command argument. See [Backups](../admin/backups.md). |

Commands that talk to the server need `MINIBOX_ACCESS_KEY` or `ACCESS_KEY`. Otherwise they stop with an error.

The installers read `MINIBOX_INSTALL_DIR`, the folder where the command is placed. The default is `~/.local/bin`, or `%USERPROFILE%\.local\bin` on Windows.

## Exit codes

| Code | Meaning |
|---|---|
| The command's own exit code | For `exec`, the exit code of the program that ran in the box |
| `124` | An `exec` timed out |
| `1` | The server returned an error |
| `2` | Wrong usage, such as an unknown option |

Commands that take `--json` print the server's JSON response, so scripts can parse it.

## Boxes

### `minibox box ls [--json]`

Lists the boxes. The output has five columns: `NAME`, `STATE`, `RUNNING`, `IMAGE` and `ID`. `box list` is the same command.

```bash
minibox box ls
```

### `minibox box create <name> [options]`

Creates and starts a box. It starts from the base template unless you choose another.

| Option | Meaning |
|---|---|
| `--template IMAGE` | The template to start from. Default: the base template. |
| `--cpus N` | CPU cores for the box |
| `--memory MB` | Memory limit, in MB |
| `--profile P` | Security profile: `standard`, `strict` or `relaxed`. Default: the `BOX_PROFILE` setting, `standard` unless changed. |
| `--repo URL` | Clones a Git repository into `/workspace` on the first create. See [Clone a repository](../user-guide/boxes.md#clone-a-repository). |
| `--branch BRANCH` | With `--repo`: a branch or tag. Default: the repository's default branch. |
| `--secret NAME` | With `--repo`: the secret that holds a token or deploy key |
| `--startup-command TEXT` | A command that runs at every start of the box. See [Startup command](../user-guide/boxes.md#startup-command). |
| `--startup-command-stdin` | Reads the startup command from standard input. Use it for a command that holds a secret, so the text stays out of the shell history. |
| `--no-wait` | Prints the clone's task ID and returns without waiting for the clone |
| `--json` | Prints the server's JSON response |

With `--repo`, the command waits for the clone. If the clone fails, the box is kept, and the command reports the reason and exits with `1`. `--startup-command` and `--startup-command-stdin` cannot be used together.

```bash
minibox box create my-app --template node-tools --repo https://github.com/example/app.git --branch main --secret GITHUB_TOKEN
minibox box create my-box --cpus 2 --memory 4096 --startup-command "python3 -m http.server 8000"
```

### `minibox box startup-command <subcommand> <box> [options]`

Reads, sets, removes or runs a box's startup command. The subcommands are:

| Subcommand | Meaning |
|---|---|
| `get` | Prints the command on standard output. Its status and the newest lines of output go to standard error. |
| `set` | Sets the command, which runs at the box's next start. Give the text with `--command TEXT`, or with `--stdin`. Give exactly one. |
| `set --apply` | Also runs the new command now, when the box is running. |
| `rm` | Removes the command. A run already going keeps going until the box stops. |
| `run` | Runs the command again now. The box must be running, and it must have a command. |

`--json` prints the response as JSON. Reading the command needs the `secret:use` scope on the token, and changing or running it needs `exec` as well.

```bash
minibox box startup-command set my-box --command "python3 -m http.server 9000" --apply
minibox box startup-command get my-box
minibox box startup-command run my-box
minibox box startup-command rm my-box
```

### `minibox exec <box> [options] -- <argv...>`

Runs a command in a box. Options must come before `--`. The words after `--` form the command. The command runs without a shell, so use `sh -c "..."` for shell syntax.

| Option | Meaning |
|---|---|
| `--cwd DIR` | Working directory. Default `/workspace`. |
| `--user USER` | User inside the box. Default `dev`. A box with the `strict` profile accepts only `dev` or `1000`. |
| `--timeout SEC` | Stops the process tree after `SEC` seconds. Default `30`. A foreground command can use at most `55`. With `--background`, use a larger value, up to `3600`. |
| `--env K=V` | Sets an environment variable. Repeat it for more variables. The value is not logged. |
| `--stdin TEXT` | Writes `TEXT` to the command's standard input, then closes it. |
| `--background` | Starts the command and prints its exec ID. The command runs on in the box. |
| `--wait MS` | With `--background`, waits once for up to `MS` milliseconds. If the command finishes, its output and exit code are printed. Otherwise the exec ID is printed. |

```bash
minibox exec my-box -- uname -a
minibox exec my-box --cwd /workspace/app --env NODE_ENV=test -- npm test
minibox exec my-box --background --timeout 600 -- npm test
minibox exec my-box --background --wait 5000 -- npm test
```

A background command prints its exec ID. Use the [MCP](mcp.md) or [API](api.md) to check on it, with `exec_get` or `GET /api/execs/{execId}`.

## Sessions

A session is a tmux session in a box. See [Terminals and sessions](../user-guide/terminal-and-sessions.md).

| Command | Meaning |
|---|---|
| `minibox session ls <box> [--json]` | Lists the sessions in a box |
| `minibox session start <box> <name>` | Starts a session. If a session with that name exists, it returns that one. |
| `minibox session read <box> <name> [--lines N] [--since CURSOR] [--json]` | Prints the screen. `--lines` sets how many lines to return, default 100. The cursor for the next `--since` goes to standard error. |
| `minibox session send <box> <name> (--text TEXT \| --key KEY ...)` | Types text, or presses tmux key names in order, such as `Enter`, `Tab` or `C-c` |
| `minibox session close <box> <name>` | Ends the session. Programs in it stop. |

```bash
minibox session start my-box build
minibox session send my-box build --text "npm run build"
minibox session send my-box build --key Enter
minibox session read my-box build --lines 50
```

A session that a person has taken over in the console refuses `session send` with `taken_over`. `session read` still works.

## Files in volumes

These commands work on volumes, even when no box is running. See [Volumes and storage](../user-guide/volumes-and-storage.md).

| Command | Meaning |
|---|---|
| `minibox files ls <volume> [--path DIR] [--depth N] [--limit N] [--json]` | Lists files in a volume |
| `minibox files read <volume> <path> [--encoding utf-8\|base64]` | Prints a file |
| `minibox files write <volume> <path> (--content TEXT \| --stdin) [--encoding utf-8\|base64]` | Writes a file from text, or from standard input |
| `minibox files cp <volume> <from> <to>` | Copies a file or folder inside a volume |
| `minibox files download <volume> [path]` | Prints a base64-encoded tar archive of the path |
| `minibox files upload <volume> [path]` | Reads a base64-encoded tar archive from standard input, and extracts it at the path |

```bash
minibox files ls my-volume --path /
minibox files write my-volume notes.txt --content "hello"
minibox files read my-volume notes.txt
```

### Copy files to and from a box

`upload`, `download` and `cp` move files between this machine and a box's volumes. A path on the box is written `<box>:<path>`. They work while the box is stopped. Uploads stream each file's body, and a download is written to a temporary file that is then renamed into place.

| Command | Meaning |
|---|---|
| `minibox upload <local>... <box>:<path> [--overwrite]` | Uploads files or folders. With several sources, or a path that ends in `/`, the files go into that folder. A folder is uploaded with its tree. |
| `minibox download <box>:<path> [local] [--overwrite]` | Downloads a file, or a folder as `<name>.tar.gz`, into `local`. The default is this folder. |
| `minibox cp <from>... <to> [--overwrite]` | Copies in either direction. The side with the box path is the box. A box path that no volume backs is refused, and so is a copy with a box on both sides or on neither. |

Symbolic links inside an uploaded folder are skipped, with a note on standard error, and are never followed. An existing file is kept unless `--overwrite` is given.

```bash
minibox upload ./site mybox:/workspace/
minibox download mybox:/workspace/report.txt
minibox cp mybox:/workspace/report.txt ./report.txt
```

## Templates and images

Building a template, rebuilding one and pulling an image are for the owner only. Each one runs as a task. The command waits for the task, prints the task log to standard error, and exits with `1` if the task fails. `--no-wait` prints the task ID and returns at once. See [Templates](../user-guide/templates.md).

| Command | Meaning |
|---|---|
| `minibox template create <name> (--dockerfile FILE \| --repo URL \| --context URL \| --devcontainer URL) [options]` | Builds a template from one source, and prints its reference, such as `minibox-template:node-tools` |
| `minibox template rebuild <ref>` | Rebuilds a template from the source it was built from. The tag moves only when the build succeeds. |
| `minibox image pull <ref>` | Pulls an image from its registry, unless the engine already has it |

The options of `template create`:

| Option | Meaning |
|---|---|
| `--dockerfile FILE` | Builds from a Dockerfile. `--dockerfile -` reads it from standard input. |
| `--repo URL` | Builds from a Git repository, cloned shallowly |
| `--context URL` | Builds from a `.tar` or `.tar.gz` build context |
| `--devcontainer URL` | Builds from the `devcontainer.json` of a repository |
| `--branch BRANCH` | With `--repo` or `--devcontainer`: a branch or tag. Default: the repository's default branch. |
| `--secret NAME` | With `--repo` or `--devcontainer`: the secret for a private repository |
| `--subdir DIR` | With `--repo`: the build context inside the repository |
| `--dockerfile-path PATH` | With `--repo` or `--context`: the Dockerfile, relative to the build context |
| `--devcontainer-path PATH` | With `--devcontainer`: the `devcontainer.json` inside the repository |
| `--description TEXT` | A description of up to 200 characters |

```bash
minibox template create node-tools --dockerfile ./Dockerfile
minibox template create node-tools --repo https://github.com/example/app.git --branch main --subdir services/api --secret DEPLOY_TOKEN
minibox template rebuild minibox-template:node-tools
minibox image pull node:24-bookworm-slim
```

## Custom tools

Only the owner can use these commands. See [Tools](../user-guide/tools.md).

| Command | Meaning |
|---|---|
| `minibox tool custom list [--json]` | Lists the custom entries in `DATA_DIR/tools.d` |
| `minibox tool custom put <id> (--file FILE \| --stdin) [--override-builtin] [--json]` | Saves an entry from a JSON document. `--override-builtin` replaces a built-in tool's entry. |
| `minibox tool custom delete <id> [--json]` | Removes the entry. Nothing is uninstalled from the shared tools volume. |

## Backups

The `backup` commands use the access key, and they are for the owner only. `restore` works on an archive file, and it needs no running server. See [Backups](../admin/backups.md).

| Command | Meaning |
|---|---|
| `minibox backup [--out FILE] [--overwrite] [--passphrase-stdin] [--json]` | Backs up DATA_DIR on the server into a sealed archive, while MiniBox runs. With `--out`, it also downloads the archive to `FILE`, and checks its size and checksum. Without `--out`, the backup stays on the server, and the command prints its ID. |
| `minibox backup ls [--json]` | Lists the backups kept on the server |
| `minibox backup rm <id> [--json]` | Deletes a backup kept on the server |
| `minibox restore <file> --data-dir DIR [--passphrase-stdin]` | Restores an archive into an empty `DIR`. Without `--data-dir`, it uses `DATA_DIR`. Stop MiniBox first. |

The passphrase comes from `MINIBOX_BACKUP_PASSPHRASE`, or from the first line of standard input with `--passphrase-stdin`.

```bash
read -rs -p "Backup passphrase: " MINIBOX_BACKUP_PASSPHRASE && export MINIBOX_BACKUP_PASSPHRASE
minibox backup --out minibox-backup.mbbak
minibox restore minibox-backup.mbbak --data-dir /srv/minibox-data
```

## Recycle bin

The recycle bin keeps the data of deleted boxes and volumes until it expires. Only the owner can use these commands. See [Checkpoints](../user-guide/checkpoints.md#recycle-bin).

| Command | Meaning |
|---|---|
| `minibox trash ls [--json]` | Lists the entries, newest deletion first, with each one's ID, name, kind, deletion time, expiry time and size |
| `minibox trash restore <id> [--name NAME] [--cpus N] [--memory MB] [--no-wait] [--json]` | Restores an entry as a new box or volume, and removes the entry once the restore has finished. `--cpus` and `--memory` apply to a box. |
| `minibox trash purge <id> [--no-wait] [--json]` | Removes an entry and the data it keeps, before it expires |

A restore and a purge run as tasks. The command waits for the task and prints its log to standard error, unless `--no-wait` is given.

## Notifications

Notification channels have no commands yet. Set them up in **Settings**, or through the [REST API](api.md#notify) and the [MCP tools](mcp.md#meta). See [Notifications](../user-guide/notifications.md).

## SSH

| Command | Meaning |
|---|---|
| `minibox ssh-config [--append] [--url URL] [--token KEY]` | Prints the `~/.ssh/config` block and the host key pin. With `--append`, it writes both, and saves the server address and key for `ssh-proxy`. `--url` and `--token` override the environment for that command. `--token` leaves the key in your shell history. |
| `minibox ssh-proxy <box>` | Carries one SSH connection over standard input and output. The `ProxyCommand` from `ssh-config` runs this command. |

See [SSH access and the command-line tool](../user-guide/ssh-and-cli.md) for the setup steps.

## MCP

| Command | Meaning |
|---|---|
| `minibox mcp [--toolsets LIST]` | Runs an MCP server over standard input and output, and forwards it to the server's `/mcp` endpoint. `LIST` is a comma-separated list of toolsets. The default is `core,meta`. |

See [MCP tools](mcp.md) for the toolsets.
