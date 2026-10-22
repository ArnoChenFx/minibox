# Connecting AI agents

MiniBox lets AI agents work inside boxes. An agent can connect in three ways:

- **MCP** over HTTP at `/mcp`. MCP clients connect with a bearer token.
- **The `minibox` command-line tool**, which the agent runs from its shell. `minibox mcp` starts an MCP server over standard input and output, and forwards it to `/mcp`.
- **The REST API**, for scripts and other tools. See the [API reference](../reference/api.md).

Use an agent token for each agent, not the access key. The access key is the owner's key. An agent with it can run commands as root in any box that does not use the `strict` profile, and it can delete and rebuild boxes. An agent token gives only the permissions that you choose.

## Create a token for an agent

1. Open **Settings**, and click **New token** in **Agent API tokens**.
2. Choose the **Sandboxed agent** preset for most agents. It cannot mount existing volumes, install tools or open SSH connections.
3. Limit the **Boxes** the token may use, and set an expiry if you want one.
4. Click **New token**, and copy the secret. MiniBox shows it once.

See [Access, sessions and tokens](access-and-tokens.md) for the presets and scopes.

## Connect an MCP client

Add a server to the client's MCP settings. Use the URL of your MiniBox server, and the token as a bearer token:

```json
{ "mcpServers": { "minibox": { "url": "http://127.0.0.1:3920/mcp", "headers": { "Authorization": "Bearer mbx_…" } } } }
```

For a client that starts a command, run `minibox mcp`. Set `MINIBOX_URL` and `MINIBOX_ACCESS_KEY` to the server address and the agent's token.

## Toolsets

The MCP endpoint offers its tools in groups called toolsets. The default is `core,meta`. To use more toolsets, add them to the URL, such as `http://127.0.0.1:3920/mcp?toolsets=core,session`.

The `rebuild_box` tool is in the `rebuild` toolset, so it is available only when you add `rebuild`. In the same way, `move_box` is in the `move` toolset. Each toolset and its tools are listed in the [MCP reference](../reference/mcp.md).

## What an agent can do in a box

- **Run commands** with `exec`. A foreground command can run for up to 55 seconds. For a longer command, run it in the background, for up to 3600 seconds, and check on it with `exec_get`. A box can have 8 background commands running at once, and the server up to 64.
- **Drive a terminal session** with `session_start`, `session_send` and `session_read`. A session keeps running after the agent disconnects. See [Terminals and sessions](terminal-and-sessions.md).
- **Read and write files** in volumes with `read_file`, `write_file`, `list_files` and `copy_files`. These work even when no box is running.
- **Install and manage tools** with the `tools` toolset.
- **Build templates and pull images** with the `tools` toolset, for the owner only. See [Templates](templates.md).
- **Manage volumes and storage pools** with the `storage` toolset. Changes that need your confirmation return a preview until the agent sends `confirm: true`.

An agent cannot see or use a box, a volume or a host that its token does not allow.

## Checkpoints

Taking, listing, forking and rolling back checkpoints are available through the [REST API](../reference/api.md) only. A token needs the `checkpoint:create` or `checkpoint:restore` scope.

Exporting and importing checkpoint packages, and setting a checkpoint schedule, are owner only, so no agent token can do them. The [MCP reference](../reference/mcp.md) lists the storage tools that do.

## Stop an agent

To stop an agent, revoke its token in **Settings**, under **Agent API tokens**. Revoking ends the agent's MCP sessions, its open terminals and its event streams.

## Instructions for AGENTS.md

Paste this into the `AGENTS.md` file of the project that the agent works in. It tells the agent how to use MiniBox:

```markdown
## MiniBox

Use the MiniBox MCP server (`/mcp`, Bearer access key or agent token) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box, which changes its revision, unless the box's TTL has passed: then exec fails with box_ttl_expired. Read the revision again before an update that sends expectedRevision.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace. A strict box allows only dev or 1000 as the user. The box needs /bin/sh, cat, rm and sleep.
- Pass secrets in env, not in argv or cmd. The audit log keeps commands and argv, but never env values.
- To give a box a host secret, pass `env` with `{ "name", "secretRef" }` entries to `create_box`. The call takes the secret's name, never its value. A token without `secret:use` is refused, and a secret that is not set fails the create.
- The result includes status, exitCode, stdout, stderr, truncated and durationMs. A non-zero exit code is the program's status.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When truncated is true, outputRef names the rest: GET /api/execs/{execId}/output.
- A foreground exec may set timeoutSec up to 55. For a longer command, use exec with background true and a larger timeoutSec (up to 3600), then exec_get with waitMs (max 25000). exec_kill stops the process tree.
- exec can read and write every volume mounted on that box.
- rebuild_box is in the rebuild toolset (`/mcp?toolsets=rebuild`) and needs confirm true.
- move_box is in the move toolset (`/mcp?toolsets=move`) and needs confirm true. Without it the call changes nothing and returns confirmation_required with details.preview. It moves a box to another host: volumes are copied or attached there, the box is recreated and started if it runs, and the old container is removed once the new one runs. Only the owner or an admin credential can move a box.
- session_start, session_send and session_read drive a tmux session in the box. They are in the session toolset (`/mcp?toolsets=core,session`). A session keeps running after you disconnect. Use exec for one-off commands and a session for long-running or interactive programs. Listing and closing sessions are in the REST API and the CLI only.
- A session started through MCP has origin agent. A person can take it over in the console. While they hold it, session_send fails with taken_over and retryable true: wait a little, read the session with session_read, and send again. session_read still works during a takeover.
- session_read returns lines and a cursor. Pass the newest cursor as since to read only what is new. reset true means the screen was redrawn, and lines is the current window.
- session_send takes keys (tmux names such as Enter, Tab, Escape or C-c) or text, but not both. The audit log keeps the counts, never the input.
- The tools toolset (`/mcp?toolsets=tools`) holds list_tools, install_tool, upgrade_tool, uninstall_tool, reconcile_tools, save_template, create_template, rebuild_template and pull_image. Installs write to the shared tools volume and update BoxSpec.tools. save_template saves a box as a template: it is long-running, returns a task id, and leaves out `/workspace` and home volumes. create_template builds a template from a Dockerfile, a repository, a build context or a devcontainer.json, rebuild_template rebuilds one from its source, and pull_image pulls an image. Only the owner may use these three, and each returns a task id. list_custom_tools, put_custom_tool and delete_custom_tool manage the custom catalog in DATA_DIR/tools.d. Only the owner may use them. delete_custom_tool removes the file and does not uninstall the tool.
- The storage toolset (`/mcp?toolsets=storage`) holds the volume and pool tools. create_volume, delete_volume, attach_volume, detach_volume and replace_pools need confirm true. Without it the call changes nothing and returns confirmation_required with details.preview. attach_volume and detach_volume rebuild the box, so the same mount rules apply as to rebuild_box. measure_volume only refreshes the cached size. Checkpoint export, import and schedule tools are in the same toolset, for the owner only: export_checkpoint returns a task whose result holds a package id, import_checkpoint imports a package uploaded with POST /api/packages, and get_checkpoint_schedule, set_checkpoint_schedule and clear_checkpoint_schedule manage a box's schedule. A scheduled checkpoint never wakes a stopped or sleeping box. The audit log and the task record never hold a passphrase.
- The network toolset (`/mcp?toolsets=network`) holds list_ports and expose_port for path-mode previews under `/box/<name>/<port>/`.
- read_file, write_file, list_files and copy_files act on volumes (not boxes). They work when no box is running, via a helper container and the Docker archive API. A call keeps the boxes that mount the volume awake while it runs, and it never starts a stopped box. Paths are jailed inside the volume. write_file stamps uid/gid 1000 (dev). exec already implies volume RW on mounts of boxes the token may use; files:* only matters without exec.
- The default toolsets are core and meta. Add others with `?toolsets=`, for example `/mcp?toolsets=core,meta,session`. Taking, listing, forking and rolling back checkpoints have no MCP tools: use the REST API (`/api/boxes/{id}/checkpoints`, `/api/checkpoints`).
```
