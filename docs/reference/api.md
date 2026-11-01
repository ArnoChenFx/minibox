# REST API reference

Every MiniBox operation is available over a JSON REST API under `/api`. The console, the [CLI](cli.md) and the [MCP tools](mcp.md) use the same operations.

The full machine-readable description is the OpenAPI 3.1 document in [`openapi.json`](../openapi.json). Import it into any OpenAPI tool to generate a client. The document describes 168 operations in 23 groups.

## Authentication

Send one of these with each request:

- The session cookie that `POST /api/auth/login` sets in a browser.
- An `Authorization: Bearer` header. The value is the access key, or an agent token (`mbx_…`). Create agent tokens in **Settings** or with `POST /api/tokens`.
- An `Authorization: Bearer` header with a box's self token, which is written to `/run/minibox/self-token` in that box. It reaches only the `self` operations of its own box, and every other operation answers `403`. See [Connecting AI agents](../user-guide/agents.md#a-boxs-own-agent).

Operations marked **public** need no credentials. A token can call only the operations its scopes allow. See [Access, sessions and tokens](../user-guide/access-and-tokens.md).

```bash
curl -s -H "Authorization: Bearer $MINIBOX_ACCESS_KEY" http://127.0.0.1:3920/api/boxes
```

## Operation scopes and token scopes

Each operation in `openapi.json` has an `x-scope` value, such as `box:session` or `template:write`. This is the operation's own scope. It is not a token scope, and you cannot give it to a token. A token passes an operation when it holds one of the token scopes in this table. The [token scopes](../user-guide/access-and-tokens.md#scopes) are the ones you choose when you create a token.

| Operation scope (`x-scope`) | Token scopes that allow it |
|---|---|
| `box:read`, `events:read`, `task:read`, `template:read` | `box:read` |
| `box:write` | `box:write` |
| `box:delete` | `box:delete` |
| `box:exec`, `box:session` | `exec` |
| `snapshot:read`, `checkpoint:read` | `box:read`, `checkpoint:create` or `checkpoint:restore` |
| `snapshot:write`, `snapshot:delete`, `checkpoint:create`, `checkpoint:write`, `checkpoint:delete` | `checkpoint:create` |
| `checkpoint:restore` | `checkpoint:restore` |
| `template:write`, `template:delete`, `tool:install` | `tool:install` |
| `pool:read`, `pool:admin`, `volume:prune` | Owner or unmodified admin identity |
| `volume:read` | `volume:read` |
| `volume:write` | `volume:write`; explicit volume creation/deletion also requires storage administrator identity |
| `volume:attach` | `volume:attach` |
| `volume:delete` | `volume:delete` with storage administrator identity. The admin preset includes it |
| `files:read` | `files:read` or `exec` |
| `files:write` | `files:write` or `exec` |
| `port:expose` | `port:expose` |
| `secret:use` | `secret:use`. Setting, removing or running a box's startup command also needs `exec`. |
| `backup:manage`, `checkpoint:usage`, `checkpoint:export`, `checkpoint:import`, `checkpoint:copy`, `checkpoint:schedule`, `host:manage`, `notify:manage`, `secret:manage`, `target:manage`, `task:write`, `template:build`, `template:official`, `trash:read`, `trash:restore`, `trash:purge`, `token:manage`, `tool:custom` | None. Only the access key can call these. |
| `self` | None. Only the self token of the box can call these, and only for that box. |

Storage pool operations and orphan pruning accept the owner or an unmodified admin token. Explicit volume creation/deletion and `mounts[].pool` also require this identity; individual scopes do not grant it. Default Box role provisioning uses the caller's Box and volume scopes. See the [storage permission matrix](../user-guide/access-and-tokens.md#storage-administration).

The scope check comes first. The token's box, volume and host grants, its quotas and the operation's own rules then apply too. The `skipTrash` option of `DELETE /api/boxes/{id}`, `DELETE /api/volumes/{id}` and `POST /api/volumes/delete` also needs the `trash:skip` token scope, or the owner. `box:ssh` is a token scope with no operation of its own: it allows the SSH gateway. `secret:use` also allows a create or rebuild that refers to a secret, including the secret of a repository clone.

## Requests

- Send JSON bodies, and set `Content-Type: application/json` on every write. A write with another content type gets `415`. A write with neither a body nor a `Content-Type` is accepted. The exceptions are the package upload, `POST /api/packages`, which takes the raw bytes of a `.mbckpt` file, and the volume file upload, `PUT /api/volumes/{id}/files/stream`, which takes the raw bytes of one file. Both take `application/octet-stream` and need a `Content-Length` header, which gets `411` when it is missing.
- Cross-site browser requests that upgrade a WebSocket, change state through the API, or read the event or box log streams are refused with `403`. See [Security](../admin/security.md).
- A request may send an `X-Minibox-Run` header that names the client session it belongs to. The audit events of one session share this value. It takes 1 to 64 letters, digits, dots, colons, underscores or hyphens, and starts with a letter or digit. Any other value gets `400`.
- Some writes need the box's current revision. Send it in the `If-Match` header. A missing header gets `428`, a stale revision gets `412`, and a malformed value gets `400`. The box's `revision` field shows the current value.

## Long-running operations

Some operations take a while, such as template builds, checkpoints, exports, imports, copies, duplicates, rollbacks, recycle bin restores and purges, and tool installs. They return `202` with a `taskId` at once. The work continues on the server.

- `GET /api/tasks/{id}` shows the task, including its status and result.
- `GET /api/tasks/{id}/events` streams its progress as server-sent events. It is not in the OpenAPI document.
- A task has the status `queued`, `running`, `succeeded`, `failed`, `cancelled` or `interrupted`. After a restart, tasks that were queued or running become `interrupted`.
- Tool installs, upgrades, uninstalls and **Install missing** on one host run one at a time, because they share its tools volume. A request made while another runs gets `202` with a task in `queued`, which starts when the tasks ahead of it end, in the order they were queued. Repeating a request that is still queued or running returns that task's `taskId` instead of starting a second one. `POST /api/tasks/{id}/cancel` takes a queued task out of the queue without running it.

## Errors

Errors have the same shape, with the matching HTTP status:

```json
{ "error": { "code": "validation_failed", "message": "…", "hint": "…", "retryable": false, "details": { "field": "cpus" } } }
```

- `retryable` is always present. It is `true` for `408`, `429` and `5xx` responses, unless a handler sets it otherwise.
- `hint` appears when a next step would help. `hintKey` is the key the console uses to translate it.

| Code | Status | Meaning |
|---|---|---|
| `validation_failed` | 400 | A field is invalid. `details.field` names it. A `mounts` entry that names both a volume and a role, or neither, is `mount_create_invalid`; a role listed twice is `mount_create_role_duplicate`; a role mount at another path is `mount_create_role_path`; a role mount that picks a pool the host does not have is `pool_not_found` |
| `unauthorized` | 401 | No valid credentials |
| `forbidden` | 403 | The credentials lack the scope, or the request came from another site |
| `not_found` | 404 | The object does not exist |
| `method_not_allowed` | 405 | The method is not supported on this path |
| `conflict` | 409 | The request conflicts with the current state |
| `confirmation_required` | 409 | A change needs `confirm: true`. `details.preview` shows what would change. |
| `volume_over_limit` | 409 | A box mounts a volume that is over its hard limit with the `stop` action. Raise or clear the limit, or free space in the volume, and then start the box |
| `precondition_failed` | 412 | The `If-Match` revision is stale |
| `unsupported_media_type` | 415 | The `Content-Type` is not JSON |
| `insufficient_capacity` | 422 | The host does not have enough capacity for the request, or `auto` with `hostLabels` found no online host that carries them (`host_auto_no_label_match`) |
| `precondition_required` | 428 | A required `If-Match` header is missing |
| `too_many_requests` | 429 | A limit was reached. Try again later. |
| `docker_error` | 502 | The Docker engine returned an error |
| `bad_gateway` | 502 | A storage server or another upstream refused the request |
| `docker_unavailable` | 503 | The Docker engine, or a storage pool, cannot be reached |
| `insufficient_storage` | 507 | The host disk is below its free-space minimum (`HOST_DISK_MIN_FREE_PERCENT`), so no volume or checkpoint is created until space is freed |

Error messages are in English. The `code` is stable, so scripts should check it rather than the message.

## Operations that are not in the OpenAPI document

These are streams, sockets, file routes and preview routes. They are not described in the OpenAPI document.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/stream` | Live events, as server-sent events. Accepts the same filters as `GET /api/events`. A stream without filters also carries live state. |
| `GET` | `/api/boxes/{id}/logs/stream?tail=N` | A box's log, as server-sent events. Sends the newest `N` lines first, then new lines as they arrive. |
| `GET` | `/api/tasks/{id}/events` | A task's progress, as server-sent events |
| `GET` | `/api/boxes/{id}/terminal` | A WebSocket for a terminal in a box. The `session` query parameter names the tmux session to attach to. Used by the console. A Bearer caller can read the output, but its input is refused, and its terminal needs tmux 3.2 or later in the box. |
| `GET` | `/api/ssh/{box}` | A WebSocket that carries one SSH connection to a box. Used by `ssh-proxy`. With a plain GET, it runs the checks and returns `204`, or the refusal as JSON. |
| `GET` | `/api/ssh/host-key` | The SSH gateway's host key: `algorithm`, `fingerprint` and `publicKey`, and `direct` with the `host` and `port` that the SSH dialog shows, or `null` while direct SSH is off. `host` is `null` unless `SSH_PUBLIC_HOST` is set. |
| `POST` | `/mcp` | The MCP endpoint. See [MCP tools](mcp.md). |
| `GET` | `/box/{name-or-id}/{port}/…` | Port preview in path mode, the default. Served only while `PREVIEW_BASE_DOMAIN` is not set; otherwise it returns `404`. Proxies HTTP and WebSocket to a port in a box. See [Port preview](../user-guide/port-preview.md). |
| Any | `https://<port>-<box>.<PREVIEW_BASE_DOMAIN>/…` | Port preview in subdomain mode, when `PREVIEW_BASE_DOMAIN` is set. Proxies HTTP and WebSocket to a port in a box. It needs a grant cookie, which the launcher below issues. Any other name under the base domain, and the base domain itself, returns `404`. See [Subdomain previews](../admin/preview-subdomains.md). |
| `GET` | `/api/boxes/{id}/ports/{port}/preview` | Opens a port in subdomain mode. It needs the sign-in cookie, not a bearer token, and returns `302` to a one-time link on the preview host. Returns `404` when `PREVIEW_BASE_DOMAIN` is not set. |
| `GET` | `/api/preview/setup` | The preview setup that the Settings page shows: the mode, and in subdomain mode the base domain and the self-check results. Owner only. |
| `GET` | `/cli/install.sh`, `/cli/install.ps1` | The CLI installers. Public. |
| `GET` | `/cli/checksums.txt`, `/cli/minibox-<os>-<arch>` | Checksums and CLI binaries. Public. |

## Events and tasks

The event log records every operation that changes state, and it can be searched.

- `GET /api/events` lists events, newest first. Filter by `box`, `principal`, `op`, `status`, `run` or `since`, and page with `cursor` and `limit` (default 50, maximum 200). `op` takes one operation, such as `box.create`, or a family, such as `exec.*`. `reads=failed` leaves out the reads that succeeded and keeps the changes and the failed or refused reads.
- `GET /api/events/stream` sends the same events live. A client that reconnects sends its last `id` as `Last-Event-ID`, and receives the events it missed.

Events are kept according to the retention settings in [Configuration](configuration.md#events-and-logs).

## Operations

The tables below list every operation in [`openapi.json`](../openapi.json), grouped by tag. Each row is one operation. Paths use `{id}` for a box or volume ID.

### boxes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/boxes` | List boxes |
| `POST` | `/api/boxes` | Create and start a box. `mounts` entries are either `{ volume, path, mode }` for a volume that exists, or `{ role }` for one of the box's role volumes (`workspace`, `home`, `tools`, `cache`), which MiniBox creates for the box. A role the list omits is not created, and the `tools` role mounts the host's shared tools volume, creating it when the host has none. An owner or unmodified admin may also set a role entry's `pool`, the storage pool its new volume goes to instead of the one the role's rule picks; a pool this host does not have answers `pool_not_found`, and the shared tools volume is one per pool. Omitted, `mounts` creates all four roles. A `repo` object clones a Git repository into `/workspace` on the first create. A template built from a `devcontainer.json` may forward ports and run its `postCreateCommand`. The response's `setup.taskId` names the setup task, which runs those steps, and `clone.taskId` names the same task when `repo` is given. A box created with a `startupCommand` runs it only after that whole setup has ended. `selfToken: true` gives the box's agent its self token. `host` is a host id, `auto` or absent (the local host). `hostLabels`, with `host: "auto"`, keeps the placement to the online hosts that carry every given label; see [Host labels](#host-labels) |
| `GET` | `/api/boxes/{id}` | Get one box |
| `PATCH` | `/api/boxes/{id}` | Update a box in place |
| `DELETE` | `/api/boxes/{id}` | Delete a box. Its data is kept in the recycle bin unless `skipTrash=true`, and `deleteVolume=true` also deletes the volumes it owns, which needs the owner or an unmodified admin token (others get `403 storage_admin_required` and nothing is deleted). The response's `trash` names the entry, or is `null` |
| `DELETE` | `/api/boxes/{id}/self-token` | Revoke the box's self token. The box keeps running, and the feature stays off for it |
| `POST` | `/api/boxes/{id}/start` | Start a box |
| `POST` | `/api/boxes/{id}/stop` | Stop a box |
| `POST` | `/api/boxes/{id}/restart` | Restart a box |
| `PATCH` | `/api/boxes/{id}/resources` | Change the CPU, memory or process limit of a box |
| `POST` | `/api/boxes/{id}/rebuild` | Rebuild a box from its spec. Takes a safety checkpoint first, unless `safetyCheckpoint` is `false`. A `mounts` entry naming a volume with no record yet (such as `{ "volume": "brand-new-vol", "path": "/data", "mode": "rw" }`) creates an independent volume, which needs the owner or an unmodified admin token; other tokens get `403 storage_admin_required` |
| `POST` | `/api/boxes/{id}/move` | Move a box to another host. Needs `If-Match`. Without `confirm: true` it returns `409 confirmation_required` with a preview. `via` picks the path: `direct` (the default) sends the template image and copies the volumes as archives; `checkpoint` takes a checkpoint of the box, copies it to the target, makes the box there from the copy and removes it from the old host, so no image is sent. The answer's `via` names the path taken and `leftovers` lists what stayed behind |
| `GET` | `/api/boxes/{id}/logs` | Read the recent log output of a box |
| `GET` | `/api/boxes/{id}/stats` | Read the current resource usage of a box |
| `GET` | `/api/boxes/{id}/startup-command` | Read a box's startup command and its status. Needs `secret:use` |
| `PUT` | `/api/boxes/{id}/startup-command` | Set a box's startup command, as `{ "command", "applyNow" }`. Needs `If-Match`, `exec` and `secret:use` |
| `DELETE` | `/api/boxes/{id}/startup-command` | Remove a box's startup command. Needs `If-Match`, `exec` and `secret:use` |
| `POST` | `/api/boxes/{id}/startup-command/run` | Run a box's startup command again now. The box must be running. Needs `exec` and `secret:use` |
| `GET` | `/api/boxes/{id}/staged` | Read a box's staged changes. `staged` is `null` when nothing is staged |
| `PUT` | `/api/boxes/{id}/staged` | Stage changes that rebuild a box: `template`, `mounts`, `env`, `network`, `egress`, `profile` |
| `DELETE` | `/api/boxes/{id}/staged` | Discard a box's staged changes |
| `GET` | `/api/boxes/{id}/staged/preview` | Preview applying a box's staged changes |
| `POST` | `/api/boxes/{id}/staged/apply` | Apply a box's staged changes. Needs `If-Match`; owner only |
| `GET` | `/api/staged` | Every box's staged changes in one read, as `{ "staged": [{ "box", "staged" }] }`. Only boxes with something staged are listed, and a box that cannot be read is skipped |

### exec

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/boxes/{id}/exec` | Run a command in a box |
| `GET` | `/api/execs/{execId}` | Read an exec |
| `POST` | `/api/execs/{execId}/kill` | Kill an exec |
| `GET` | `/api/execs/{execId}/output` | Read saved exec output |

### ports

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/boxes/{id}/ports` | List listening and manually exposed ports on a box |
| `POST` | `/api/boxes/{id}/ports` | Remember a port for preview |
| `DELETE` | `/api/boxes/{id}/ports/{port}` | Remove a manually exposed preview port |

### files

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/volumes/{id}/files/content` | Read a file from a volume |
| `PUT` | `/api/volumes/{id}/files/content` | Write a file on a volume |
| `GET` | `/api/volumes/{id}/files` | List files on a volume |
| `POST` | `/api/volumes/{id}/files/copy` | Copy files within a volume |
| `GET` | `/api/volumes/{id}/files/archive` | Download a volume path as tar |
| `PUT` | `/api/volumes/{id}/files/archive` | Upload a tar onto a volume path |
| `GET` | `/api/volumes/{id}/files/stream` | Download a file, or a folder as a gzip tar named `<name>.tar.gz` |
| `PUT` | `/api/volumes/{id}/files/stream` | Upload one file as a raw `application/octet-stream` body. Query: `path`, and `overwrite` (default `false`, which answers `409` for an existing file). Answers `413` above `FILE_UPLOAD_MAX_MB` |
| `POST` | `/api/volumes/{id}/files/directory` | Create a folder, with any missing parents |
| `POST` | `/api/volumes/{id}/files/move` | Move or rename a path. The target must be free |
| `DELETE` | `/api/volumes/{id}/files` | Delete a file or folder. Without `confirm=true` the answer is `409` with a preview of the removal. The root of a volume cannot be deleted |

### volumes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/volumes` | List volumes. Each has `sharedTools`: `true` only for the shared tools volume that boxes mount, which cannot be deleted |
| `POST` | `/api/volumes` | Create an independent volume. Only the owner may set `role: "tools"`; a token, even an unmodified admin token, gets `403 volume_tools_create_forbidden` |
| `GET` | `/api/volumes/{id}` | Get a volume, with the same `sharedTools` field |
| `DELETE` | `/api/volumes/{id}` | Delete a volume. Its data is kept in the recycle bin unless `skipTrash=true`. The shared tools volume answers `409 volume_shared_tools`; a spare tools-role volume that boxes do not get can be deleted. The response's `trash` names the entry, or is `null` |
| `POST` | `/api/volumes/delete` | Delete up to 100 volumes by `ids`, on any host. Without `confirm: true` the answer is `409` with `details.preview`. Each volume has its own result in `volumes`, and one failure does not stop the others. A volume outside the credential's resource grants is refused with `volume_delete_forbidden`. Takes `skipTrash` |
| `POST` | `/api/volumes/prune` | List the orphaned volumes: MiniBox volumes that no box or container uses. With `dryRun: false` the volumes named in `ids`, which must be the ids the dry run listed, are removed; nothing else is, and a named volume that is no longer an orphan, or is the tools volume, a system volume or in use, is refused with its reason. `dryRun` defaults to `true`. Owner or unmodified admin only. `olderThan`, such as `30d`, keeps the volumes used more recently. Each host is reported in `hosts`. An offline or failing host is skipped |
| `POST` | `/api/volumes/{id}/attach` | Mount a volume on a box. Takes a safety checkpoint of the box first, unless `safetyCheckpoint` is `false` |
| `POST` | `/api/volumes/{id}/detach` | Unmount a volume from a box. Takes a safety checkpoint of the box first, unless `safetyCheckpoint` is `false` |
| `POST` | `/api/volumes/{id}/checkpoints` | Snapshot one volume on its own, as a checkpoint whose record names no box. Takes `label` and `pinned`. Returns `202`; the finished task holds the checkpoint. A cache or tools volume answers `400` |
| `POST` | `/api/volumes/{id}/usage` | Measure a volume |
| `PUT` | `/api/volumes/{id}/limits` | Set a volume's soft and hard limits in bytes, and the action at the hard limit (`warn` or `stop`). A field left out keeps its value, and `null` clears a limit. Owner only. An NFS volume answers `400` |
| `GET` | `/api/pools` | List storage pools. Owner or unmodified admin only |
| `PUT` | `/api/pools` | Replace storage pool configuration. Owner or unmodified admin only |

### tools

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tools/catalog` | List the tool catalog without install status |
| `GET` | `/api/tools` | List tool catalog and install status. Each entry also carries its `install`, `upgrade`, `uninstall`, `stop` (null when unset) and `detect` commands, so the console can copy a built-in tool's catalog entry as JSON |
| `POST` | `/api/boxes/{id}/tools/install` | Install a tool into the shared tools volume |
| `POST` | `/api/boxes/{id}/tools/upgrade` | Upgrade a tool on the shared tools volume |
| `POST` | `/api/boxes/{id}/tools/uninstall` | Uninstall a tool from the shared tools volume |
| `POST` | `/api/boxes/{id}/tools/reconcile` | Install missing tools from the box spec |
| `GET` | `/api/tools/custom` | List the custom tool entries in DATA_DIR/tools.d |
| `PUT` | `/api/tools/custom/{id}` | Create or replace a custom tool entry in DATA_DIR/tools.d |
| `DELETE` | `/api/tools/custom/{id}` | Delete a custom tool entry from tools.d. Nothing is uninstalled from the shared tools volume. |

### secrets

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/secrets` | List secrets |
| `PUT` | `/api/secrets/{name}` | Create or replace a secret |
| `DELETE` | `/api/secrets/{name}` | Delete a secret |

### ssh

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ssh-keys` | List SSH keys |
| `POST` | `/api/ssh-keys` | Add an SSH key. The body is `{ publicKey, label? }`, one OpenSSH public key line. A private key, or a key that is already added, is refused. |
| `DELETE` | `/api/ssh-keys/{id}` | Delete an SSH key |

These are owner only. A key logs in to every box over direct SSH, so no token may add one.

### sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/boxes/{id}/sessions` | List the terminal sessions of a box |
| `POST` | `/api/boxes/{id}/sessions` | Start a terminal session in a box |
| `GET` | `/api/boxes/{id}/sessions/{name}` | Read a terminal session |
| `DELETE` | `/api/boxes/{id}/sessions/{name}` | Close a terminal session |
| `POST` | `/api/boxes/{id}/sessions/{name}/input` | Send keys or text to a terminal session |

### snapshots

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/snapshots` | List snapshots |
| `POST` | `/api/boxes/{id}/snapshots` | Snapshot a box |
| `POST` | `/api/snapshots/{ref}/boxes` | Create a box from a snapshot |
| `DELETE` | `/api/snapshots/{ref}` | Delete a snapshot |

### checkpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/checkpoints` | List checkpoints. Recycle bin entries are not listed here; see [trash](#trash) |
| `GET` | `/api/checkpoints/usage` | Read the checkpoint repository's size against its limit |
| `GET` | `/api/checkpoints/{id}` | Get one checkpoint |
| `PATCH` | `/api/checkpoints/{id}` | Pin or relabel a checkpoint |
| `DELETE` | `/api/checkpoints/{id}` | Delete a checkpoint |
| `POST` | `/api/boxes/{id}/checkpoints` | Take a checkpoint of a box. A host whose remote-only position is being changed answers `409 checkpoint_remote_relocating` before any layer is written |
| `POST` | `/api/checkpoints/{id}/fork` | Create a box from a checkpoint |
| `POST` | `/api/checkpoints/{id}/copy` | Copy a checkpoint to another host `{ "host" }`. Returns `202`; the task result holds the copy. A target whose remote-only position is being changed answers `409 checkpoint_remote_relocating`. Owner only |
| `GET` | `/api/boxes/{id}/rollback` | Read the rollback of a box that waits for its confirm or undo |
| `GET` | `/api/rollbacks` | Every waiting rollback in one read, as `{ "rollbacks": [{ "box", "rollback" }] }`. Only boxes that wait are listed, and a record that cannot be read is skipped |
| `POST` | `/api/boxes/{id}/rollback` | Roll a box back to one of its checkpoints |
| `POST` | `/api/boxes/{id}/rollback/confirm` | Confirm a rollback: delete the volumes it replaced |
| `POST` | `/api/boxes/{id}/rollback/undo` | Undo a rollback: mount the volumes it replaced again |
| `POST` | `/api/checkpoints/{id}/export` | Export a checkpoint as a sealed package `{ "passphrase" }`. Returns `202`; the task result holds the package. Owner only |
| `POST` | `/api/packages` | Upload a `.mbckpt` package as raw `application/octet-stream`. Returns `201` with the package. Owner only. Not in the OpenAPI document |
| `GET` | `/api/packages/{id}/download` | Download a package as `<id>.mbckpt`. A package expires 24 hours after its export. Owner only. Not in the OpenAPI document |
| `POST` | `/api/packages/{id}/import` | Import an uploaded package as a checkpoint `{ "passphrase", "host"? }`. `host` defaults to `local`. Returns `202`; the task result holds the checkpoint. A host whose remote-only position is being changed answers `409 checkpoint_remote_relocating`. Owner only |
| `GET` | `/api/boxes/{id}/checkpoint-schedule` | Read a box's checkpoint schedule, with its next and last run. `null` when none is set. `timezoneUnknown` is `true` when the saved zone is one the server no longer knows; the schedule then runs in UTC until it is set again. Owner only |
| `PUT` | `/api/boxes/{id}/checkpoint-schedule` | Set a schedule `{ "everyHours" }` or `{ "at": "HH:MM", "timezone" }`, not both. `timezone` is an IANA zone such as `Asia/Shanghai`; without it the time is UTC, and an unknown zone or a UTC offset such as `+08:00` is `400`. Replaces any schedule the box has. Owner only |
| `DELETE` | `/api/boxes/{id}/checkpoint-schedule` | Remove a box's schedule. Checkpoints already taken are kept. Owner only |
| `GET` | `/api/hosts/{id}/checkpoint-remote` | Read a host's remote checkpoint repository, including its `mode`, or `null` when it has none. Owner only |
| `PUT` | `/api/hosts/{id}/checkpoint-remote` | Set a host's remote checkpoint repository `{ "targetId", "path"?, "mode"? }` on an S3 or an SFTP target. `mode` is `sync` (the default: keep a local repository and copy to this one) or `only` (keep no local repository and do everything on the remote). The host id is appended to the path, so hosts never share a repository. Changing the mode, or moving or clearing an only-remote repository, needs a host with no checkpoint records (`409 checkpoint_remote_has_checkpoints`). A change that involves `only` is refused while a checkpoint write is in flight (`409 checkpoint_remote_write_busy`) and refuses a write while it runs (`409 checkpoint_remote_relocating`). Setting `only` opens the repository first and refuses a target it cannot reach or a password that does not open it (`502 checkpoint_remote_check_failed`); a save that changes nothing does not open it. Owner only |
| `DELETE` | `/api/hosts/{id}/checkpoint-remote` | Clear a host's remote checkpoint repository. Snapshots already copied stay on the target. An only-remote repository can be cleared only when the host has no checkpoint records (`409 checkpoint_remote_has_checkpoints`), and not while a checkpoint write is in flight (`409 checkpoint_remote_write_busy`). Owner only |
| `POST` | `/api/hosts/{id}/checkpoint-remote/sync` | Copy the host's pending checkpoint snapshots to its remote repository, as a task. Returns `202`; the task result holds the counts. A host in `only` mode has nothing local to copy and answers `409 checkpoint_remote_only_no_sync`. Owner only |

### backups

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/backups` | Back up DATA_DIR into a sealed archive, as a task. Takes `{ "passphrase" }`. Returns `202`; the task result holds the backup. Owner only |
| `GET` | `/api/backups` | List the backups kept on the server, newest first. Owner only |
| `GET` | `/api/backups/{id}/download` | Download a backup archive as `<id>.mbbak`. Owner only |
| `DELETE` | `/api/backups/{id}` | Delete a backup kept on the server. Owner only |
| `GET` | `/api/backups/schedule` | Read the instance's backup schedule, with its next and last run. `null` when none is set, which is the default. `timezoneUnknown` is `true` when the saved zone is one the server no longer knows; the schedule then runs in UTC until it is set again. Owner only |
| `PUT` | `/api/backups/schedule` | Set the schedule `{ "everyHours" }` or `{ "at": "HH:MM", "timezone" }`, not both. `timezone` is an IANA zone such as `Asia/Shanghai`; without it the time is UTC, and an unknown zone or a UTC offset such as `+08:00` is `400`. A due run seals one backup with `BACKUP_PASSPHRASE`, and `BACKUP_KEEP` then applies. Replaces any schedule the instance has. Owner only |
| `DELETE` | `/api/backups/schedule` | Remove the backup schedule. Backups already made are kept. Owner only |

A due run makes one backup through the same service as `POST /api/backups`, so it appears in `GET /api/backups` with origin `create`. A run that fell due while MiniBox was down happens once when it comes back, and a failed run is recorded on the schedule and logged once. See [Scheduled backups](../admin/backups.md#scheduled-backups).

### targets

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/targets` | List off-site targets. Credentials are never returned. Owner only |
| `POST` | `/api/targets` | Add an S3-compatible, SFTP or WebDAV target. Takes its fields, and the credentials are stored as secrets. Owner only |
| `POST` | `/api/targets/test` | Reach a target with the given details, and store nothing. Owner only |
| `GET` | `/api/targets/{id}/check` | Reach a stored target with its own credentials. Owner only |
| `GET` | `/api/targets/{id}/objects` | List the complete packages and backups on a target, newest first. Owner only |
| `DELETE` | `/api/targets/{id}` | Remove a target and its stored credentials. Objects on the target are kept. Owner only |
| `POST` | `/api/targets/{id}/push` | Push a package (`pk_…`) or a backup (`bk_…`) to a target, as a task. Owner only |
| `POST` | `/api/targets/{id}/pull` | Pull a package or a backup from a target, as a task. Owner only |

Targets take the fields of `POST /api/targets`. An S3 target takes `endpoint`, `region`, `bucket`, `accessKeyId` and `secretAccessKey`. An SFTP target takes `host`, `port`, `user`, `privateKey` and `hostKeyFingerprint`. The fingerprint comes from `POST /api/targets/test`, which reports the server's key when the key is not yet known. A WebDAV target takes `url`, `user` and `password`, where `url` is the `https` address of the collection the objects live under. See [Backups](../admin/backups.md#off-site-targets).

### trash

The recycle bin holds the data of deleted boxes and volumes. Its entries are not checkpoints, so they are not in `GET /api/checkpoints`. These operations are for the owner only.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/trash` | List the recycle bin, newest deletion first. The `trash` array holds each entry's `id`, `hostId`, `kind` (`box` or `volume`), `sourceId`, `sourceName`, `deletedAt`, `expiresAt`, `bytes` and `createdBy` |
| `POST` | `/api/trash/{id}/restore` | Restore an entry as a new box or volume, as a task. Takes `name`, and for a box `cpus` and `memoryMb`, all optional. The entry is removed once the restore has finished |
| `DELETE` | `/api/trash/{id}` | Purge an entry now, as a task. Its data cannot be restored afterwards |
| `POST` | `/api/trash/empty` | Purge every entry on every host now, and return one result per entry. Without `confirm: true` it changes nothing and answers `409` `confirmation_required` with `details.preview`, which lists the entries. `ids` limits the empty to the entries the preview listed. An entry that is being restored, purged or exported, or whose host is offline, is left and reported with its reason; the rest are still purged. The response holds `removed`, `refused`, `failed`, `bytes`, `entries` and `hosts`. Needs the owner: no token scope allows it, `trash:skip` included |

An entry is kept for `TRASH_RETENTION_DAYS` days, see [Configuration](configuration.md#checkpoints). Each delete, restore and purge is recorded as an event: `box.trashed` or `volume.trashed`, `trash.restored` or `trash.purged`.

### templates

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/templates` | List templates |
| `GET` | `/api/templates/official` | List the official templates: name, ref, description and base image. Owner only |
| `POST` | `/api/templates` | Build a template from a source, as a task. Owner only |
| `POST` | `/api/templates/{ref}/duplicate` | Duplicate a template into a new one under `name`, with an optional `description`: a template with a build source (an official template no host has built yet included) becomes a not built draft, and one saved from a box becomes an image copy. Answers `201` with `{ template: { ref, name } }`. Owner only |
| `GET` | `/api/templates/{ref}/recipe` | Read the source a template rebuilds from, as `{ recipe: { buildKind, source, postCreate?, forwardPorts? } }`. A template with no source answers `400` (`template_not_declared`) |
| `PATCH` | `/api/templates/{ref}` | Change the source a template rebuilds from, its setup and its description, without building it. The image stays as it is until a rebuild. Needs `tool:install`: the owner may edit any template, a token only one it created. An official template's source cannot be replaced (`400`, `template_source_builtin`) |
| `POST` | `/api/templates/{ref}/rebuild` | Rebuild a template from the source it was built from, as a task. Owner only |
| `POST` | `/api/templates/{ref}/sync` | Copy a template to another host, as a task. The body is `{ host }`. Owner only |
| `POST` | `/api/images/pull` | Pull an image from its registry, as a task, unless the engine has it. Owner only |
| `POST` | `/api/snapshots/{ref}/promote` | Promote a snapshot to a template |
| `POST` | `/api/boxes/{id}/template` | Save a box as a template |
| `POST` | `/api/templates/base/build` | Build the bundled base template |
| `POST` | `/api/templates/official/{name}/build` | Build an official template (`node`, `python`, `go` or `minimal`) as a task, on the host in `?host=`. Owner only |
| `DELETE` | `/api/templates/{ref}` | Delete a template |

`POST /api/templates` takes `name`, an optional `description` and a `source`. The source's `kind` is `dockerfile` (with `text`), `git` (with `url`, and optional `branch`, `subdir`, `dockerfile` and `secretRef`), `context` (with `url` of a `.tar` or `.tar.gz` archive, and optional `dockerfile`) or `devcontainer` (with `url`, and optional `branch`, `path` and `secretRef`). A `devcontainer` source reads the settings that [Templates](../user-guide/templates.md#devcontainerjson) lists, and warns in the build log about any other. The task's result holds `template.ref`, such as `minibox-template:node-tools`. `POST /api/images/pull` takes `ref`, such as `node:24-bookworm-slim`, and its task's result holds `image.ref` and `image.id`. See [Templates](../user-guide/templates.md).

`host` names the host an operation runs on. In a body it is the `host` field, as in `POST /api/templates`, `POST /api/images/pull` and `POST /api/templates/{ref}/sync`, where it is the host to copy to. As a query parameter it is `?host=`, as in `POST /api/templates/{ref}/rebuild`, `POST /api/templates/{ref}/duplicate`, `POST /api/templates/base/build`, `POST /api/templates/official/{name}/build` and `DELETE /api/templates/{ref}`. Without it, a build or a pull runs on `local`, and a rebuild, a duplicate or a delete runs on the first host that holds the template, or on `local` when no host holds it and it names an official template.

`POST /api/templates/{ref}/duplicate` duplicates a template instead of building one, so it answers at once with the new template rather than with a task: `{ template: { ref, name } }`. The body is `name`, an optional `description` and an optional `host`, and `?host=` picks the host that holds the template to copy. A template with a build source, and the bundled base template, become a saved draft: the recipe is written with `imageId: null` and `draft: true`, holding the copied source, `init` and description, and no image is created, so the copy has no size and no creation time until `POST /api/templates/{ref}/rebuild` builds it. An official template no host has built yet has no image either, so its duplicate is a draft from a copy of the Dockerfile MiniBox ships, saved on the request's host; when that file cannot be read the call fails with `500` (`template_source_unreadable`) and writes nothing. A template saved from a box has no source to copy, so its duplicate commits an image from the source template's image with the labels a template carries (`template`, `template.name`, `template.description`, `createdBy` and `created`), and has no recipe, so it cannot be rebuilt or edited. The source keeps its own tag, labels, recipe and boxes. A name an image or a draft already holds is refused with `409` (`template_name_taken`), a name MiniBox builds itself (`base`, `node`, `python`, `go`, `minimal`) with `409` (`template_name_reserved`) when the duplicate is a draft, and a ref that names no template or official template with `404` (`template_not_found`). See [Duplicate a template](../user-guide/templates.md#duplicate-a-template).

`PATCH /api/templates/{ref}` takes an optional `source`, an optional `init` and an optional `description`, and answers `200` with `{ template: { ref, name, buildKind } }`. A field it leaves out keeps the value the recipe has, so an edit that only changes the Dockerfile does not send the rest. `init` is `{ postCreate, forwardPorts }` and replaces the setup a box created from the template gets; `init: null` clears it. Nothing is built, so the template keeps its image, and the next `POST /api/templates/{ref}/rebuild` builds the edited source. A new `description` is committed onto the image under the same tag, so the template's card shows it at once. An edit that names none of the three fields is refused with `400` (`template_edit_empty`), and so is an edit of a template with no source, such as one saved from a box (`400`, `template_not_declared`). The source of an official template cannot be replaced, because its Dockerfile ships with MiniBox (`400`, `template_source_builtin`); its `init` and `description` are the template's own and stay editable. Another change to the same template while an edit or a build holds it is refused with `409` (`template_busy`). See [Edit what a template rebuilds from](../user-guide/templates.md#edit-what-a-template-rebuilds-from).

`GET /api/templates/{ref}/recipe` reads the same recipe, so a client can prefill an editor: `{ recipe: { buildKind, source, postCreate?, forwardPorts? } }`, where `source` holds the fields of its kind, including the pasted Dockerfile as `text`.

`POST /api/templates/official/{name}/build` returns `202` with `taskId`, and its task's result holds `template.ref`. A name that the host already holds is refused with `409` (`template_name_taken`). `POST /api/boxes` gives a missing official template to the host the box goes to: it copies the template from a host that holds it, or else builds it there, as a task that the create waits for. The response then holds `sync.taskId`, as it does for a copy. See [Official templates](../user-guide/templates.md#official-templates).

### tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks` | List tasks |
| `GET` | `/api/tasks/{id}` | Get a task |
| `POST` | `/api/tasks/{id}/cancel` | Cancel a task |

### events

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events` | List recorded events, newest first |

### tokens

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tokens/presets` | List the permission groups and what each token preset grants (owner only) |
| `GET` | `/api/tokens` | List agent API tokens |
| `POST` | `/api/tokens` | Create an agent API token |
| `DELETE` | `/api/tokens/{id}` | Revoke an agent API token |

### hosts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/hosts` | List hosts |
| `GET` | `/api/hosts/usage` | Show what each host runs and uses |
| `GET` | `/api/hosts/{id}/disk` | What the host's engine holds, as `docker system df` counts it: images, containers, volumes and build cache, each with its total and reclaimable bytes. Owner only. An agent host has no reading, and a host whose engine does not answer reports why. See [Engine storage](#engine-storage-docker-system-df) |
| `POST` | `/api/hosts/{id}/forward` | Add the `FORWARD` rule the overview's forwarding warning offers, after the owner confirms it. Owner only. See [The egress forward allowance](#the-egress-forward-allowance) |
| `POST` | `/api/hosts/{id}/force-remove` | Forget a lost host's records while it is offline: its boxes, its volume records (the shared tools volume too) and its checkpoint records. No engine is contacted and nothing on the machine is deleted. Without `confirm: true` it changes nothing and answers `409` `confirmation_required` with `details.preview`, whose `digest` names the records it lists. Send that `digest` with `confirm: true` and a changed set answers `409` `host_records_changed` with a fresh preview and discards nothing; without a `digest` the call discards whatever the host holds. Owner only. See [Force-remove a lost machine](../user-guide/hosts.md#force-remove-a-lost-machine) |
| `POST` | `/api/hosts` | Add a host. Takes the fields below, plus an optional `labels` object, which is checked as `PATCH /api/hosts/{id}` checks it |
| `POST` | `/api/hosts/test` | Test a host connection |
| `PATCH` | `/api/hosts/{id}` | Replace a host's labels, as `{ "labels": { "gpu": "true" } }`. The local host takes them too. An empty object clears them. Returns `200` with the host |
| `POST` | `/api/hosts/pairing` | Create a one-time pairing code for a new agent host `{ "id", "name"? }`. Returns `201` with the code and when it expires |
| `POST` | `/api/hosts/{id}/revoke` | Revoke an agent host. Its agent is disconnected and cannot reconnect |
| `DELETE` | `/api/hosts/{id}` | Remove a host. An agent host's agent is revoked first: it is disconnected and cannot reconnect. Refused with `409` while the host still has boxes, volumes or checkpoints |

Each host in `GET /api/hosts` carries `labels`: the labels it can be selected by, empty when it carries none.

#### Host ids and names

A host is identified by its **id** everywhere: every path, query, task, event, audit entry and CLI argument names a host by `id`, and no endpoint resolves a host by its display name. `name` is only the label the console shows and the server quotes in messages, so a client must send an id, never a name.

Two hosts may not hold the same name. `POST /api/hosts` and `POST /api/hosts/pairing` refuse a name that another host already holds. `POST /api/agent/pair` has no need to ask: the name was checked when the code was issued, and the code holds it until it is spent, so the same refusal there is only a guard. The answer is `409` with the key `host_name_taken`, whose `params` are `{ "name", "host" }`: the name asked for and the id of the host that already uses it. Names are compared in Unicode NFC, trimmed and without their case, so `Lab` and ` lab ` are the same name, and so are `Café` typed with a combining accent and with a precomposed one. A host sent without `name` falls back to its id, and that fallback is checked the same way: while another host is called `lab`, a host with id `lab` and no `name` is refused with `host_name_taken_by_id` (same `params`), which asks for a name. The check does not compare a name with an id, so a name that reads like another host's id is allowed.

A pairing code that has not been used yet holds its name as well, since it names the host it will create. Another host or code asking for that name gets `409` `host_name_pending`, whose `params` are `{ "name", "host" }`, with `host` the id the waiting code is for. A code does not hold its name against its own id: a new `POST /api/hosts/pairing` for the same id is accepted at once, with the same or another name, and replaces the code still waiting, so only the newest code for a host pairs. The replaced code is refused at `POST /api/agent/pair` with `401` and the key `agent_pairing_replaced`.

A result that reports several hosts at once, such as `hosts` in a volume prune or a recycle-bin empty, keeps each host's own `name` beside its `hostId`. Where an older hosts file still holds two hosts of one name, the messages that quote a host add its id to the name, as `Lab · edge`.

A hosts file that already holds two hosts with one name still loads: the check runs when a name is given, not at startup. MiniBox has no rename endpoint, so the only way to free a name is `DELETE /api/hosts/{id}`.

An agent connects on its own: it exchanges the pairing code at `POST /api/agent/pair`, then keeps a WebSocket open at `/api/agent/connect`. Both are used by the agent, not by clients. See [Agent](agent.md).

#### Engine storage (`docker system df`)

`GET /api/hosts/{id}/disk` answers what one host's engine holds, the way `docker system df` reports it. It is a read, so it changes nothing, and it needs the owner: no token scope reaches it.

```json
{
  "id": "local",
  "status": "online",
  "checkedAt": "2026-10-26T10:00:00.000Z",
  "supported": true,
  "reason": null,
  "detail": null,
  "breakdown": {
    "images":     { "count": 4, "activeCount": 2, "totalBytes": 629145600, "reclaimableBytes": 209715200 },
    "containers": { "count": 3, "activeCount": 1, "totalBytes": 31457280,  "reclaimableBytes": 20971520 },
    "volumes":    { "count": 6, "activeCount": 5, "totalBytes": 3145728000, "reclaimableBytes": 524288000 },
    "buildCache": { "count": 9, "activeCount": 0, "totalBytes": 943718400, "reclaimableBytes": 943718400 }
  }
}
```

`breakdown` holds one entry per class, each with the entries the engine holds (`count`), the entries in use (`activeCount`: images a container uses, running or paused containers, volumes a container mounts, build cache in use), the bytes the class takes (`totalBytes`) and the bytes removing everything unused would free (`reclaimableBytes`).

The reading is the engine's own accounting, not the host filesystem's. The disk watermark that MiniBox enforces is a different figure, read from the filesystem the engine's root directory is on; it is not part of this answer. See [Volumes and storage](../user-guide/volumes-and-storage.md#host-free-space).

**A figure the engine does not report is `null`, never zero.** Engines differ: API 1.52 and later answer `ImageUsage`, `ContainerUsage`, `VolumeUsage` and `BuildCacheUsage` with totals per class, and older engines answer plain arrays with no counts, which MiniBox sums. A class the engine leaves out entirely is `null`, and so is any figure within one. So a class, or a figure, that a given engine cannot report is shown as unknown rather than as nothing.

**A host with no reading answers `breakdown: null` and a `reason`**, with status `200` rather than an error, so a page that lists several hosts keeps working when one of them cannot answer:

| `reason` | When |
|---|---|
| `agent_host` | The host is a MiniBox agent. Its engine is behind the agent's own connection, which does not carry this read, so `supported` is `false`. An agent host never has a reading. |
| `offline` | The host's last connection check failed, or its engine refused the read as unavailable. The engine is not asked again while the host is offline. |
| `timeout` | The engine did not answer within the host's read timeout, the same `readTimeoutMs` a box read uses (5 s). |
| `engine` | The engine answered with an error. `detail` holds its own message. |

A host id no host carries answers `404` (`host_not_found`).

#### The egress forward allowance

`POST /api/hosts/{id}/forward` is what the overview's **Proxy-only boxes have no internet** item offers as its button. It is a write, and it needs the owner: no token scope reaches it. MiniBox never calls it on its own.

It answers the reading taken right after the change, in the shape the overview reads:

```json
{
  "host": {
    "bridge": "br-1a2b3c4d5e6f",
    "forwarding": true,
    "detail": "iptables accepts br-1a2b3c4d5e6f; iptables-legacy FORWARD policy is ACCEPT",
    "boxes": ["agent"],
    "at": "2026-10-26T10:00:00.000Z",
    "repaired": true,
    "skipped": null
  }
}
```

`forwarding` is what a new connection arriving on `bridge` and leaving for another interface would get. The call adds one chain of MiniBox's own, `MINIBOX-FWD-<hash>`, jumped to from the top of `FORWARD` in every readable iptables backend, which accepts that traffic and its replies. Nothing else on the host's firewall changes: the `FORWARD` policy stays as it is and other installs' chains are left alone. A repair that did not work answers `forwarding: false`, so the warning stays until a check finds the rules right.

| Answer | When |
|---|---|
| `409 egress_forward_no_boxes` | The host has no `proxy-only` box, so nothing needs the rule. Nothing was changed. |
| `409 egress_forward_unchecked` | The host's rules have not been read yet, so the bridge is not known. Wait for the next check, or add the rule by hand. |
| `409 egress_forward_unsupported` | The check cannot run on this host, which today means an agent host. |
| `404 host_not_found` | No host carries that id. |

#### Host labels

A host label is a key and a value, and `hostLabels` on a box create matches them. A key is lowercase letters, digits, dots, underscores and hyphens, starting with a letter, and may name a namespace with one slash, as in `org/arch`. A value is a single line of at most 256 characters, and may be empty. A host carries at most 32 labels. A label that breaks a rule is refused with `400` and the key `host_labels_invalid`, and nothing is written.

`POST /api/boxes` takes `hostLabels` with `host: "auto"`:

```json
{ "name": "trainer", "cpus": 4, "memoryMb": 8192, "host": "auto", "hostLabels": { "gpu": "true", "org/arch": "amd64" } }
```

Only the online hosts that carry every entry are considered, and each value has to match exactly. The rest of the placement is unchanged: a host that holds the template comes before one that does not, the roomiest of them wins, and only an owner's official template may be built on a host that lacks it. With `hostLabels`, a create that names a host is refused with `400` `host_labels_need_auto`, and a set of labels that no online host carries is refused with `422` `insufficient_capacity` and the key `host_auto_no_label_match`, which names the labels in `params.labels`. Without `hostLabels` the placement is exactly what it was, so `local` stays the default and the template and overcommit rules do not change. See [Hosts](../user-guide/hosts.md#choose-a-host-by-labels).

The local host's labels can also come from `HOST_LABELS` (see [Configuration](configuration.md)); `PATCH /api/hosts/local` overrides them, and the hosts file keeps the result.

### notify

Notification channels. Only the owner can use these operations, because no token holds the `notify:manage` scope. See [Notifications](../user-guide/notifications.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/notify/channels` | List channels. A secret is never returned: `hasSecret` says whether one is stored |
| `PUT` | `/api/notify/channels/{id}` | Create or change a channel, as `{ "name", "type", "events", "boxes", "enabled", "url", "server", "topic", "chatId", "secret" }`. `type` is `webhook`, `ntfy` or `telegram`, and `events` lists at least one notice kind. Returns `200`. The answer's `created` says whether the channel is new, and `valueChange` says whether its secret was `set`, `cleared` or `kept`. Returns `409` when 32 channels exist |
| `DELETE` | `/api/notify/channels/{id}` | Delete a channel and its stored secret. Its deliveries stay in the event log |
| `POST` | `/api/notify/channels/{id}/test` | Send one test notice, with no retries, and return `{ "ok", "status", "attempts", "error" }`. A send that fails still answers `200`, with `ok` set to `false` |
| `GET` | `/api/notify/deliveries?limit=N` | List recent deliveries, newest first. `limit` is 1 to 200 and defaults to 50 |

A `webhook` channel needs `url`. An `ntfy` channel needs `topic`, and takes an optional `server` that defaults to `https://ntfy.sh`. A `telegram` channel needs `chatId`, and a new one needs its bot token as `secret`. `boxes` limits the channel to the named boxes or ids, and host notices are never filtered by it.

`secret` is the webhook signing key, the ntfy access token or the Telegram bot token. Omit it to keep the stored value, send `null` to clear it, or send a string of 8 to 512 characters to replace it. The value is never copied into an answer or an event.

### questions

Questions that a box's agent asked. A person reads and answers them in the console, on the box's page. The agent asks with `POST /api/self/questions`. See [Connecting AI agents](../user-guide/agents.md#a-boxs-own-agent).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/boxes/{id}/questions` | List the questions a box's agent asked, newest first |
| `POST` | `/api/questions/{id}/answer` | Answer a question, as `{ "answer" }`. When the question offers options, the answer must be one of them. An answer can be given once: a second one returns `409` |

### self

Operations for a box's own agent, which calls them with the box's self token. The owner and other tokens get `403`. Each operation acts on that box alone.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/self` | This box's name, state, template, size and remaining TTL |
| `POST` | `/api/self/checkpoints` | Take a checkpoint of this box, as `{ "label", "reason", "consistency" }`, with `consistency` as `live` or `pause`. Returns `202` with a task |
| `GET` | `/api/self/tasks/{id}` | A task that this box started |
| `POST` | `/api/self/status` | Report `working`, `waiting`, `done` or `failed`, with a one-line `note` |
| `POST` | `/api/self/questions` | Ask a person a question, as `{ "message", "options" }`. Returns `201` with the question |
| `GET` | `/api/self/questions/{id}` | A question that this box asked, with its answer once one is given |
