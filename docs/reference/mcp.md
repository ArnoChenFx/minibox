# MCP tools reference

MiniBox serves the [Model Context Protocol](https://modelcontextprotocol.io) at `/mcp`. An MCP client can list the tools and call them, in the same way that the console and the CLI call the REST API.

For how to connect an agent, see [Connecting AI agents](../user-guide/agents.md).

## The endpoint

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/mcp` | Streamable HTTP MCP. Send JSON-RPC messages here. |
| `GET` | `/mcp` | Returns `405` with `Allow: POST, DELETE`. The server does not open a server-to-client stream. |
| `DELETE` | `/mcp` | Closes the session named by the `Mcp-Session-Id` header. |

Send `Authorization: Bearer` with the access key or an agent token. A browser sign-in cookie is refused. A wrong bearer key counts toward the same sign-in limit as a wrong login key.

A session belongs to the credential that opened it. It ends when that token is revoked.

`tools/list` offers a token only the tools that its scopes allow. A call that the token may not make returns a tool error with the code `forbidden`, and does nothing.

## Toolsets

The endpoint's tools are grouped into toolsets. Choose them with the `toolsets` query parameter, as a comma-separated list:

```
http://127.0.0.1:3920/mcp?toolsets=core,session
```

The default is `core,meta`. The `minibox mcp` command takes the same list with `--toolsets`, or with the `MINIBOX_TOOLSETS` environment variable.

| Toolset | What it is for |
|---|---|
| `core` | Boxes, commands and files in volumes. On by default. |
| `meta` | Hosts and notification channels. On by default. |
| `session` | Terminal sessions in boxes |
| `rebuild` | Rebuilding a box. Not on by default. Enable it with `toolsets=rebuild`. |
| `move` | Moving a box to another host. Not on by default. Enable it with `toolsets=move`. |
| `storage` | Volumes, storage pools, the owner's recycle bin, the owner's checkpoint export, import and schedules, and the owner's backups and off-site targets |
| `tools` | Installing tools, custom tools, saving templates, building and rebuilding templates, and pulling images |
| `network` | Preview ports |

## Tools by toolset

The tables below list each tool and the operation it calls, taken from the `x-mcp` entries in [`openapi.json`](../openapi.json). The [REST API reference](api.md) describes each operation.

### core

| Tool | Operation it calls |
|---|---|
| `list_boxes` | `GET /api/boxes` |
| `create_box` | `POST /api/boxes` |
| `get_box` | `GET /api/boxes/{id}` |
| `update_box` | `PATCH /api/boxes/{id}` |
| `delete_box` | `DELETE /api/boxes/{id}` |
| `box_action` | `POST /api/boxes/{id}/start`, `POST /api/boxes/{id}/stop`, `POST /api/boxes/{id}/restart` |
| `exec` | `POST /api/boxes/{id}/exec` |
| `exec_get` | `GET /api/execs/{execId}` |
| `exec_kill` | `POST /api/execs/{execId}/kill` |
| `read_file` | `GET /api/volumes/{id}/files/content` |
| `write_file` | `PUT /api/volumes/{id}/files/content` |
| `list_files` | `GET /api/volumes/{id}/files` |
| `copy_files` | `POST /api/volumes/{id}/files/copy` |
| `get_startup_command` | `GET /api/boxes/{id}/startup-command` |
| `set_startup_command` | `PUT /api/boxes/{id}/startup-command` |
| `delete_startup_command` | `DELETE /api/boxes/{id}/startup-command` |
| `run_startup_command` | `POST /api/boxes/{id}/startup-command/run` |
| `upload_files` | `PUT /api/volumes/{id}/files/archive` |

`upload_files` takes a base64 tar of at most 2 MiB encoded. A larger file goes through `PUT /api/volumes/{id}/files/stream` or `minibox upload`, which stream the body rather than send it as a JSON argument.

### meta

| Tool | Operation it calls |
|---|---|
| `list_hosts` | `GET /api/hosts` |
| `get_host_usage` | `GET /api/hosts/usage` |
| `add_host` | `POST /api/hosts` |
| `test_host` | `POST /api/hosts/test` |
| `remove_host` | `DELETE /api/hosts/{id}` |
| `list_notify_channels` | `GET /api/notify/channels`. Owner only |
| `set_notify_channel` | `PUT /api/notify/channels/{id}`. Owner only |
| `delete_notify_channel` | `DELETE /api/notify/channels/{id}`. Owner only |
| `test_notify_channel` | `POST /api/notify/channels/{id}/test`. Owner only |
| `list_notify_deliveries` | `GET /api/notify/deliveries`. Owner only |

### rebuild

| Tool | Operation it calls |
|---|---|
| `rebuild_box` | `POST /api/boxes/{id}/rebuild` |

### move

| Tool | Operation it calls |
|---|---|
| `move_box` | `POST /api/boxes/{id}/move` |

### session

| Tool | Operation it calls |
|---|---|
| `session_start` | `POST /api/boxes/{id}/sessions` |
| `session_read` | `GET /api/boxes/{id}/sessions/{name}` |
| `session_send` | `POST /api/boxes/{id}/sessions/{name}/input` |

### storage

| Tool | Operation it calls |
|---|---|
| `list_volumes` | `GET /api/volumes` |
| `create_volume` | `POST /api/volumes` |
| `get_volume` | `GET /api/volumes/{id}` |
| `delete_volume` | `DELETE /api/volumes/{id}` |
| `attach_volume` | `POST /api/volumes/{id}/attach` |
| `detach_volume` | `POST /api/volumes/{id}/detach` |
| `measure_volume` | `POST /api/volumes/{id}/usage` |
| `set_volume_limits` | `PUT /api/volumes/{id}/limits`. Owner only. Soft limits are best effort, not a quota |
| `list_pools` | `GET /api/pools` |
| `replace_pools` | `PUT /api/pools` |
| `export_checkpoint` | `POST /api/checkpoints/{id}/export`. Owner only. The task result holds the package |
| `import_checkpoint` | `POST /api/packages/{id}/import`. Owner only |
| `get_checkpoint_schedule` | `GET /api/boxes/{id}/checkpoint-schedule`. Owner only |
| `set_checkpoint_schedule` | `PUT /api/boxes/{id}/checkpoint-schedule`. Owner only |
| `clear_checkpoint_schedule` | `DELETE /api/boxes/{id}/checkpoint-schedule`. Owner only |
| `create_backup` | `POST /api/backups`. Owner only. The task result holds the backup |
| `list_backups` | `GET /api/backups`. Owner only |
| `delete_backup` | `DELETE /api/backups/{id}`. Owner only |
| `list_targets` | `GET /api/targets`. Owner only |
| `test_target` | `POST /api/targets/test`. Owner only |
| `add_target` | `POST /api/targets`. Owner only |
| `check_target` | `GET /api/targets/{id}/check`. Owner only |
| `list_target_objects` | `GET /api/targets/{id}/objects`. Owner only |
| `remove_target` | `DELETE /api/targets/{id}`. Owner only |
| `push_to_target` | `POST /api/targets/{id}/push`. Owner only. Returns a task |
| `pull_from_target` | `POST /api/targets/{id}/pull`. Owner only. Returns a task |
| `list_trash` | `GET /api/trash`. Owner only. The recycle bin's entries |
| `restore_trash` | `POST /api/trash/{id}/restore`. Owner only. Returns a task |
| `purge_trash` | `DELETE /api/trash/{id}`. Owner only. Returns a task |

### tools

| Tool | Operation it calls |
|---|---|
| `list_tools` | `GET /api/tools` |
| `install_tool` | `POST /api/boxes/{id}/tools/install` |
| `upgrade_tool` | `POST /api/boxes/{id}/tools/upgrade` |
| `uninstall_tool` | `POST /api/boxes/{id}/tools/uninstall` |
| `reconcile_tools` | `POST /api/boxes/{id}/tools/reconcile` |
| `list_custom_tools` | `GET /api/tools/custom` |
| `put_custom_tool` | `PUT /api/tools/custom/{id}` |
| `delete_custom_tool` | `DELETE /api/tools/custom/{id}` |
| `save_template` | `POST /api/boxes/{id}/template` |
| `create_template` | `POST /api/templates`. Owner only |
| `rebuild_template` | `POST /api/templates/{ref}/rebuild`. Owner only |
| `pull_image` | `POST /api/images/pull`. Owner only |

### network

| Tool | Operation it calls |
|---|---|
| `list_ports` | `GET /api/boxes/{id}/ports` |
| `expose_port` | `POST /api/boxes/{id}/ports` |

## Confirmation

Some tools change things that are hard to undo. They need `confirm: true` in their arguments. Without it, the call changes nothing, and returns `confirmation_required` with `details.preview`, which describes what would change. These tools need confirmation:

- `create_volume`, `delete_volume`, `attach_volume`, `detach_volume` and `replace_pools`.
- `rebuild_box` and `move_box`.

`measure_volume` only refreshes a cached size, so it needs no confirmation. `attach_volume` and `detach_volume` rebuild the box, so the same mount rules apply as for `rebuild_box`.

`rebuild_box`, `attach_volume` and `detach_volume` take `safetyCheckpoint`, which defaults to `true`. Send `false` to skip the checkpoint of the box that is taken before the change. `delete_box` and `delete_volume` take `skipTrash`. Set it to `true` to delete without keeping a copy in the recycle bin. That needs the owner, or a token with the `trash:skip` scope.

## Session tools

- `session_start` starts a session, or returns the one with that name. The session's origin is `agent`.
- `session_send` takes `keys` (tmux key names, such as `Enter`, `Tab`, `Escape` or `C-c`) or `text`, but not both. The audit log records the number of keys and bytes, never the text.
- `session_read` returns lines and a cursor. Pass the newest cursor back as `since` to read only the new lines. `reset: true` means the screen was redrawn, and the lines are the current window.

A session that a person has taken over in the console refuses `session_send` with `taken_over` and `retryable: true`. `session_read` still works.

## Command tools

- `exec` takes `argv`, which runs without a shell, or `cmd`, which runs through `/bin/sh -c`. The default user is `dev`, and the default directory is `/workspace`. A `strict` box allows only `dev` or uid 1000.
- A foreground `exec` may set `timeoutSec` up to 55 seconds. For a longer command, set `background: true` and a `timeoutSec` up to 3600, then poll with `exec_get` and `waitMs` up to 25000.
- At most 8 background execs run in one box, and 64 across MiniBox. A call over either limit gets `429` with `too_many_requests`, and it does not start a stopped box.
- `exec` starts the box if it is stopped. That sets the box's desired state to running and changes its revision, so read the revision again before an update that sends `expectedRevision`.
- When an exec reaches its `timeoutSec`, MiniBox stops the exec's process tree and sets `timedOut` to `true`. The exit code is the one the engine reports, or `137` when MiniBox stopped the exec and the engine reports none. A foreground call returns with `status: running` and `timedOut: true` if the stop is still running after 2 seconds, or if it fails. A stop that is still running continues in the background. A stop that fails leaves the exec `running`, and MiniBox retries it after 1 second, then after 2, 4 and so on, up to 30 seconds.
- `exec_kill` stops the process tree.
- Output that is returned inline keeps about 16 KiB from the start and 16 KiB from the end of each stream. When `truncated` is `true`, `outputRef` names the full output, which `GET /api/execs/{execId}/output` returns.
- Commands can read and write every volume that the box mounts.

## Environment values

To give a box a host secret, pass `env` with `{ "name", "secretRef" }` entries to `create_box`. The call takes the secret's name, never its value. The token needs the `secret:use` scope, and the secret must exist.

Pass other secrets, such as API keys, in `env`, not in `argv` or `cmd`. The audit log keeps commands and argv, but never `env` values.

## Startup command

`create_box` takes an optional `startupCommand`, which the box runs at every start. The four startup tools read and change a box's startup command. `get_startup_command` needs the `secret:use` scope. `set_startup_command`, `delete_startup_command` and `run_startup_command` need `exec` and `secret:use`, because the command runs as code in the box. Each tool returns the command's status and the newest lines of its output only to a caller that may read the command.

`set_startup_command` takes `command` and an optional `applyNow`, which runs the command at once on a running box. `set_startup_command` and `delete_startup_command` take `expectedRevision`, the box's current revision. The audit log records that the command changed, never its text. See [Startup command](../user-guide/boxes.md#startup-command).

## Repository and template sources

`create_box` takes `repo` to clone a Git repository into `/workspace` on the first create. It has `url`, and optional `branch` and `secretRef`. The clone runs as a task, returned as `clone.taskId`. A `secretRef` names a secret that holds a token for HTTPS, or a base64 deploy key for SSH.

`create_template` takes `name`, an optional `description`, and a `source` whose `kind` is one of these:

- `dockerfile`, with `text`.
- `git`, with `url`, and optional `branch`, `subdir`, `dockerfile` and `secretRef`.
- `context`, with `url` of a `.tar` or `.tar.gz` archive, and optional `dockerfile`.
- `devcontainer`, with `url`, and optional `branch`, `path` and `secretRef`. It reads `image`, `build` and `containerEnv` from the `devcontainer.json` file, and refuses any other setting, including lifecycle commands.

`rebuild_template` takes the template's `ref`, and `pull_image` takes an image `ref`, such as `node:24-bookworm-slim`. Building, rebuilding and pulling are owner only. Each returns a task, and its log shows the build or the layers. See [Templates](../user-guide/templates.md).

## Notification tools

`set_notify_channel` takes the fields of `PUT /api/notify/channels/{id}`: `id`, `name`, `type` and `events`, and optionally `boxes`, `enabled`, `url`, `server`, `topic`, `chatId` and `secret`. A secret is never returned. `list_notify_channels` shows only whether one is stored, as `hasSecret`. Omit `secret` to keep the stored one, or send `null` to clear it. The tools are for the owner only, and a token does not see them in `tools/list`. See [Notifications](../user-guide/notifications.md).

## Backup and target tools

The backup and target tools are for the owner only, so a token does not see them in `tools/list`.

- `create_backup` takes a `passphrase`, so the MCP client that calls it sees the passphrase. Use the [command-line tool](cli.md#backups) with `MINIBOX_BACKUP_PASSPHRASE` when an agent should not see it.
- `add_target` takes the target's credentials as arguments, so the client sees them as well. MiniBox stores them as secrets, and no tool returns them. For an SFTP server, call `test_target` first. If the server's host key is not yet known, the call fails with the fingerprint the server presented. Pass that fingerprint to `add_target` as `hostKeyFingerprint` once you have confirmed it.
- `push_to_target` and `pull_from_target` take an object ID, `pk_…` or `bk_…`. See [Backups](../admin/backups.md#push-and-pull).
