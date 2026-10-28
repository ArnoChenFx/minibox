# MCP tools by toolset

The endpoint is `POST /mcp` (Streamable HTTP JSON-RPC, `Authorization: Bearer`). Tools are grouped into toolsets and chosen with the `toolsets` query parameter; the default is `core,meta`, and a box's own agent gets `self`.

A tool's arguments are the operation's input fields. A tool whose toolset is not enabled fails with `validation_failed` naming the toolset; a tool the token's scopes do not allow does not appear in `tools/list` at all.

| Toolset | Use it for | On by default |
|---|---|---|
| `core` | Boxes, commands, files in volumes | yes |
| `meta` | Hosts, notification channels | yes |
| `session` | Terminal sessions in boxes | no |
| `network` | Port previews | no |
| `storage` | Volumes, pools, recycle bin, checkpoint export/import/copy/schedule, backups, off-site targets | no |
| `tools` | Tool installs, templates, custom tools, image pulls | no |
| `rebuild` | `rebuild_box` | no |
| `move` | `move_box` | no |
| `self` | A box's own agent, with its self token | only for that agent |

A URL with several toolsets: `http://127.0.0.1:3920/mcp?toolsets=core,meta,session,network`.

## core

| Tool | Needs | What it does |
|---|---|---|
| `list_boxes` | `box:read` | Every visible box, with the usage of running ones. `stats`, `host` |
| `create_box` | `box:write`, plus `volume:write` for the volumes it creates and `volume:attach` for a volume it mounts | Create and start. `name`, `template`, `cpus`, `memoryMb`, `profile`, `mounts`, `env`, `idleTimeoutSec`, `ttlSec`, `host`, `tools`, `startupCommand`, `selfToken`, `repo`. A `mounts` entry is `{ volume, path, mode }` to mount a volume that exists, or `{ role }` to have MiniBox create one of the box's role volumes; a role the list omits is not created, `tools` mounts the shared tools volume, and a role entry may add `pool` to put its new volume on a pool other than the role's rule picks (`pool_not_found` when the host has none). Returns `box`, plus `setup.taskId` and `clone.taskId` |
| `get_box` | `box:read` | One box, including `revision`, `mounts`, `state`, `sleeping`, `stopReason` |
| `update_box` | `box:write` | `name`, `cpus`, `memoryMb`, `pids`, `labels`, `idleTimeoutSec`, `ttlSec`. Needs `expectedRevision`. Template, mounts, env, network, egress and profile changes are refused with `confirmation_required`; use `rebuild_box` |
| `delete_box` | `box:delete` | `deleteVolume`, `skipTrash` (owner or `trash:skip`). The data goes to the recycle bin first |
| `box_action` | `box:write` | `action`: `start`, `stop` or `restart` |
| `exec` | `exec` | `argv` or `cmd`, `cwd`, `env`, `stdin`, `user`, `timeoutSec`, `background` |
| `exec_get` | `exec` | `execId`, `waitMs` (max 25000) |
| `exec_kill` | `exec` | `execId`. Kills the process tree |
| `read_file` | `files:read` or `exec` | `id` (volume), `path`, `encoding` (`utf-8` or `base64`) |
| `write_file` | `files:write` or `exec` | `id`, `path`, `content` (at most 1 MiB), `encoding` |
| `list_files` | `files:read` or `exec` | `id`, `path`, `maxDepth` (default 2, max 8), `limit` (default 500, max 2000) |
| `copy_files` | `files:write` or `exec` | `id`, `from`, `to` |
| `upload_files` | `files:write` or `exec` | `id`, `path`, `content` (base64 tar, at most 2 MiB encoded) |
| `get_startup_command` | `secret:use` | `id` |
| `set_startup_command` | `secret:use` + `exec` | `id`, `command`, `applyNow`, `expectedRevision` |
| `delete_startup_command` | `secret:use` + `exec` | `id`, `expectedRevision` |
| `run_startup_command` | `secret:use` + `exec` | `id`. The box must be running |

## meta

| Tool | Needs | What it does |
|---|---|---|
| `list_hosts`, `get_host_usage`, `get_host_disk`, `add_host`, `test_host`, `remove_host` | owner | Host management. No token scope reaches it |

| `list_hosts`, `get_host_usage`, `add_host`, `test_host`, `set_host_labels`, `remove_host` | owner | Host management and host labels. No token scope reaches it |
| `list_notify_channels`, `set_notify_channel`, `delete_notify_channel`, `test_notify_channel`, `list_notify_deliveries` | owner | Notification channels. No token scope reaches it |

## session

| Tool | Needs | What it does |
|---|---|---|
| `session_start` | `exec` | `id`, `name`. Starts the session or returns the existing one; a stopped box is started |
| `session_send` | `exec` | `id`, `name`, and `keys` or `text` (not both) |
| `session_read` | `exec` | `id`, `name`, `lines`, `since` (the previous cursor) |

Listing and closing sessions are REST and CLI only (`GET`/`DELETE /api/boxes/{id}/sessions…`).

## network

| Tool | Needs | What it does |
|---|---|---|
| `list_ports` | `box:read` | Listening ports plus manually exposed ones, each with a preview `url` |
| `expose_port` | `port:expose` | `id`, `port`. Remembers a port for preview; publishes nothing |

## storage

| Tool | Needs | What it does |
|---|---|---|
| `list_volumes`, `get_volume`, `measure_volume` | `volume:read` | Volumes and their cached size |
| `snapshot_volume` | `checkpoint:create` | `id`, `label`, `pinned`. Snapshots one volume on its own, as a checkpoint whose record names no box. Returns a task |
| `create_volume` | `volume:write` | `name`, `pool`, `role`, `confirm` |
| `delete_volume` | `volume:write` | `id`, `confirm`, `skipTrash` |
| `delete_volumes` | `volume:delete` | `ids`, `confirm`. One result per volume |
| `attach_volume`, `detach_volume` | `volume:attach` (+ `volume:write` for `mode: "rw"`) | `id`, `box`, `path`, `mode`, `confirm`, `safetyCheckpoint`, `expectedRevision`. Rebuilds the box |
| `list_pools`, `replace_pools` | owner | Storage pools |
| `set_volume_limits` | owner | Soft and hard limits, and the action at the hard limit |
| `prune_volumes` | owner | Orphaned volumes. `dryRun` defaults to `true`; removal needs `dryRun: false` and the `ids` the dry run listed |
| `list_trash`, `restore_trash`, `purge_trash`, `empty_trash` | owner | The recycle bin. `empty_trash` needs `confirm: true` |
| `export_checkpoint`, `import_checkpoint`, `copy_checkpoint` | owner | Checkpoint packages and host copies. Each returns a task |
| `get_checkpoint_schedule`, `set_checkpoint_schedule`, `clear_checkpoint_schedule` | owner | A box's checkpoint schedule |
| `create_backup`, `list_backups`, `delete_backup` | owner | Backups of the data directory |
| `list_targets`, `test_target`, `add_target`, `check_target`, `list_target_objects`, `remove_target`, `push_to_target`, `pull_from_target` | owner | Off-site targets |

## tools

| Tool | Needs | What it does |
|---|---|---|
| `list_tools` | `box:read` | Catalog and install status |
| `install_tool`, `upgrade_tool`, `uninstall_tool`, `reconcile_tools` | `tool:install` | The shared tools volume. Each returns a task |
| `save_template` | `tool:install` | Save a box's system layer as a template. Returns a task |
| `list_templates` | `box:read` | Templates on every host |
| `create_template`, `fork_template`, `rebuild_template`, `sync_template`, `build_official_template`, `list_official_templates`, `pull_image` | owner | Template builds, forks and image pulls. Each build returns a task; a fork answers at once |
| `list_custom_tools`, `put_custom_tool`, `delete_custom_tool` | owner | `DATA_DIR/tools.d`. Deleting an entry does not uninstall the tool |

## rebuild and move

| Tool | Needs | What it does |
|---|---|---|
| `rebuild_box` | `box:write` | `id`, `template`, `mounts`, `env`, `network`, `egress`, `profile`, `confirm`, `safetyCheckpoint` |
| `move_box` | owner or admin credential | `id`, `host`, `confirm`, `expectedRevision` |

Both need `confirm: true`; without it the call changes nothing and returns `confirmation_required` with `details.preview`.

## self

Only a box's own agent, connected with the box's self token, sees these. Every other credential gets `403`.

| Tool | What it does |
|---|---|
| `get_info` | This box's name, state, template, size and remaining TTL |
| `checkpoint` | Take a checkpoint of this box (`label`, `reason`, `consistency`). Returns a task |
| `get_task` | A task this box started |
| `ask_human` | Ask a person a question (`message`, up to 1000 characters, and `options`, up to 10). Does not wait |
| `get_question` | Read the answer to a question this box asked |
| `report_status` | `working`, `waiting`, `done` or `failed`, with a one-line `note` |

A self token is limited to 60 calls a minute per box.
