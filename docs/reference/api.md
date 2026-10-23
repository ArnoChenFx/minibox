# REST API reference

Every MiniBox operation is available over a JSON REST API under `/api`. The console, the [CLI](cli.md) and the [MCP tools](mcp.md) use the same operations.

The full machine-readable description is the OpenAPI 3.1 document in [`openapi.json`](../openapi.json). Import it into any OpenAPI tool to generate a client. The document describes 134 operations in 21 groups.

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
| `volume:read` | `volume:read` |
| `volume:write` | `volume:write` |
| `volume:attach` | `volume:attach` |
| `files:read` | `files:read` or `exec` |
| `files:write` | `files:write` or `exec` |
| `port:expose` | `port:expose` |
| `secret:use` | `secret:use`. Setting, removing or running a box's startup command also needs `exec`. |
| `backup:manage`, `checkpoint:usage`, `checkpoint:export`, `checkpoint:import`, `checkpoint:schedule`, `host:manage`, `notify:manage`, `pool:read`, `pool:admin`, `secret:manage`, `target:manage`, `task:write`, `template:build`, `trash:read`, `trash:restore`, `trash:purge`, `token:manage`, `tool:custom` | None. Only the access key can call these. |
| `self` | None. Only the self token of the box can call these, and only for that box. |

The scope check comes first. The token's box, volume and host grants, its quotas and the operation's own rules then apply too. The `skipTrash` option of `DELETE /api/boxes/{id}` and `DELETE /api/volumes/{id}` also needs the `trash:skip` token scope, or the owner. `box:ssh` is a token scope with no operation of its own: it allows the SSH gateway. `secret:use` also allows a create or rebuild that refers to a secret, including the secret of a repository clone.

## Requests

- Send JSON bodies, and set `Content-Type: application/json` on every write. A write with another content type gets `415`. A write with neither a body nor a `Content-Type` is accepted. The exceptions are the package upload, `POST /api/packages`, which takes the raw bytes of a `.mbckpt` file, and the volume file upload, `PUT /api/volumes/{id}/files/stream`, which takes the raw bytes of one file. Both take `application/octet-stream` and need a `Content-Length` header, which gets `411` when it is missing.
- Cross-site browser requests that upgrade a WebSocket, change state through the API, or read the event or box log streams are refused with `403`. See [Security](../admin/security.md).
- A request may send an `X-Minibox-Run` header that names the client session it belongs to. The audit events of one session share this value. It takes 1 to 64 letters, digits, dots, colons, underscores or hyphens, and starts with a letter or digit. Any other value gets `400`.
- Some writes need the box's current revision. Send it in the `If-Match` header. A missing header gets `428`, a stale revision gets `412`, and a malformed value gets `400`. The box's `revision` field shows the current value.

## Long-running operations

Some operations take a while, such as template builds, checkpoints, exports, imports, forks, rollbacks, recycle bin restores and purges, and tool installs. They return `202` with a `taskId` at once. The work continues on the server.

- `GET /api/tasks/{id}` shows the task, including its status and result.
- `GET /api/tasks/{id}/events` streams its progress as server-sent events. It is not in the OpenAPI document.
- A task has the status `running`, `succeeded`, `failed`, `cancelled` or `interrupted`. After a restart, tasks that were running become `interrupted`.

## Errors

Errors have the same shape, with the matching HTTP status:

```json
{ "error": { "code": "validation_failed", "message": "…", "hint": "…", "retryable": false, "details": { "field": "cpus" } } }
```

- `retryable` is always present. It is `true` for `408`, `429` and `5xx` responses, unless a handler sets it otherwise.
- `hint` appears when a next step would help. `hintKey` is the key the console uses to translate it.

| Code | Status | Meaning |
|---|---|---|
| `validation_failed` | 400 | A field is invalid. `details.field` names it. |
| `unauthorized` | 401 | No valid credentials |
| `forbidden` | 403 | The credentials lack the scope, or the request came from another site |
| `not_found` | 404 | The object does not exist |
| `method_not_allowed` | 405 | The method is not supported on this path |
| `conflict` | 409 | The request conflicts with the current state |
| `confirmation_required` | 409 | A change needs `confirm: true`. `details.preview` shows what would change. |
| `volume_over_limit` | 409 | A box mounts a volume that is over its hard limit with the `stop` action. Raise or clear the limit, or free space in the volume, and then start the box |
| `precondition_failed` | 412 | The `If-Match` revision is stale |
| `unsupported_media_type` | 415 | The `Content-Type` is not JSON |
| `insufficient_capacity` | 422 | The host does not have enough capacity for the request |
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
| `GET` | `/api/ssh/host-key` | The SSH gateway's host key |
| `POST` | `/mcp` | The MCP endpoint. See [MCP tools](mcp.md). |
| `GET` | `/box/{name-or-id}/{port}/…` | Port preview in path mode, the default. Served only while `PREVIEW_BASE_DOMAIN` is not set; otherwise it returns `404`. Proxies HTTP and WebSocket to a port in a box. See [Port preview](../user-guide/port-preview.md). |
| Any | `https://<port>-<box>.<PREVIEW_BASE_DOMAIN>/…` | Port preview in subdomain mode, when `PREVIEW_BASE_DOMAIN` is set. Proxies HTTP and WebSocket to a port in a box. It needs a grant cookie, which the launcher below issues. Any other name under the base domain, and the base domain itself, returns `404`. See [Subdomain previews](../admin/preview-subdomains.md). |
| `GET` | `/api/boxes/{id}/ports/{port}/preview` | Opens a port in subdomain mode. It needs the sign-in cookie, not a bearer token, and returns `302` to a one-time link on the preview host. Returns `404` when `PREVIEW_BASE_DOMAIN` is not set. |
| `GET` | `/api/preview/setup` | The preview setup that the Settings page shows: the mode, and in subdomain mode the base domain and the self-check results. Owner only. |
| `GET` | `/cli/install.sh`, `/cli/install.ps1` | The CLI installers. Public. |
| `GET` | `/cli/checksums.txt`, `/cli/minibox-<os>-<arch>` | Checksums and CLI binaries. Public. |

## Events and tasks

The event log records every operation that changes state, and it can be searched.

- `GET /api/events` lists events, newest first. Filter by `box`, `principal`, `op`, `status`, `run` or `since`, and page with `cursor` and `limit` (default 50, maximum 200).
- `GET /api/events/stream` sends the same events live. A client that reconnects sends its last `id` as `Last-Event-ID`, and receives the events it missed.

Events are kept according to the retention settings in [Configuration](configuration.md#events-and-logs).

## Operations

The tables below list every operation in [`openapi.json`](../openapi.json), grouped by tag. Each row is one operation. Paths use `{id}` for a box or volume ID.

### boxes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/boxes` | List boxes |
| `POST` | `/api/boxes` | Create and start a box. A `repo` object clones a Git repository into `/workspace` on the first create. The response's `clone.taskId` names the clone task. `selfToken: true` gives the box's agent its self token |
| `GET` | `/api/boxes/{id}` | Get one box |
| `PATCH` | `/api/boxes/{id}` | Update a box in place |
| `DELETE` | `/api/boxes/{id}` | Delete a box. Its data is kept in the recycle bin unless `skipTrash=true`, and `deleteVolume=true` also deletes the volumes it owns. The response's `trash` names the entry, or is `null` |
| `DELETE` | `/api/boxes/{id}/self-token` | Revoke the box's self token. The box keeps running, and the feature stays off for it |
| `POST` | `/api/boxes/{id}/start` | Start a box |
| `POST` | `/api/boxes/{id}/stop` | Stop a box |
| `POST` | `/api/boxes/{id}/restart` | Restart a box |
| `PATCH` | `/api/boxes/{id}/resources` | Change the CPU, memory or process limit of a box |
| `POST` | `/api/boxes/{id}/rebuild` | Rebuild a box from its spec. Takes a safety checkpoint first, unless `safetyCheckpoint` is `false` |
| `POST` | `/api/boxes/{id}/move` | Move a box to another host. Needs `If-Match`. Without `confirm: true` it returns `409 confirmation_required` with a preview |
| `GET` | `/api/boxes/{id}/logs` | Read the recent log output of a box |
| `GET` | `/api/boxes/{id}/stats` | Read the current resource usage of a box |
| `GET` | `/api/boxes/{id}/startup-command` | Read a box's startup command and its status. Needs `secret:use` |
| `PUT` | `/api/boxes/{id}/startup-command` | Set a box's startup command, as `{ "command", "applyNow" }`. Needs `If-Match`, `exec` and `secret:use` |
| `DELETE` | `/api/boxes/{id}/startup-command` | Remove a box's startup command. Needs `If-Match`, `exec` and `secret:use` |
| `POST` | `/api/boxes/{id}/startup-command/run` | Run a box's startup command again now. The box must be running. Needs `exec` and `secret:use` |

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
| `GET` | `/api/volumes` | List volumes |
| `POST` | `/api/volumes` | Create an independent volume |
| `GET` | `/api/volumes/{id}` | Get a volume |
| `DELETE` | `/api/volumes/{id}` | Delete a volume. Its data is kept in the recycle bin unless `skipTrash=true`. The response's `trash` names the entry, or is `null` |
| `POST` | `/api/volumes/{id}/attach` | Mount a volume on a box. Takes a safety checkpoint of the box first, unless `safetyCheckpoint` is `false` |
| `POST` | `/api/volumes/{id}/detach` | Unmount a volume from a box. Takes a safety checkpoint of the box first, unless `safetyCheckpoint` is `false` |
| `POST` | `/api/volumes/{id}/usage` | Measure a volume |
| `PUT` | `/api/volumes/{id}/limits` | Set a volume's soft and hard limits in bytes, and the action at the hard limit (`warn` or `stop`). A field left out keeps its value, and `null` clears a limit. Owner only. An NFS volume answers `400` |
| `GET` | `/api/pools` | List storage pools |
| `PUT` | `/api/pools` | Replace storage pool configuration |

### tools

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tools/catalog` | List the tool catalog without install status |
| `GET` | `/api/tools` | List tool catalog and install status |
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
| `POST` | `/api/boxes/{id}/checkpoints` | Take a checkpoint of a box |
| `POST` | `/api/checkpoints/{id}/fork` | Create a box from a checkpoint |
| `GET` | `/api/boxes/{id}/rollback` | Read the rollback of a box that waits for its confirm or undo |
| `POST` | `/api/boxes/{id}/rollback` | Roll a box back to one of its checkpoints |
| `POST` | `/api/boxes/{id}/rollback/confirm` | Confirm a rollback: delete the volumes it replaced |
| `POST` | `/api/boxes/{id}/rollback/undo` | Undo a rollback: mount the volumes it replaced again |
| `POST` | `/api/checkpoints/{id}/export` | Export a checkpoint as a sealed package `{ "passphrase" }`. Returns `202`; the task result holds the package. Owner only |
| `POST` | `/api/packages` | Upload a `.mbckpt` package as raw `application/octet-stream`. Returns `201` with the package. Owner only. Not in the OpenAPI document |
| `GET` | `/api/packages/{id}/download` | Download a package as `<id>.mbckpt`. A package expires 24 hours after its export. Owner only. Not in the OpenAPI document |
| `POST` | `/api/packages/{id}/import` | Import an uploaded package as a checkpoint `{ "passphrase", "host"? }`. `host` defaults to `local`. Returns `202`; the task result holds the checkpoint. Owner only |
| `GET` | `/api/boxes/{id}/checkpoint-schedule` | Read a box's checkpoint schedule, with its next and last run. `null` when none is set. `timezoneUnknown` is `true` when the saved zone is one the server no longer knows; the schedule then runs in UTC until it is set again. Owner only |
| `PUT` | `/api/boxes/{id}/checkpoint-schedule` | Set a schedule `{ "everyHours" }` or `{ "at": "HH:MM", "timezone" }`, not both. `timezone` is an IANA zone such as `Asia/Shanghai`; without it the time is UTC, and an unknown zone or a UTC offset such as `+08:00` is `400`. Replaces any schedule the box has. Owner only |
| `DELETE` | `/api/boxes/{id}/checkpoint-schedule` | Remove a box's schedule. Checkpoints already taken are kept. Owner only |

### backups

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/backups` | Back up DATA_DIR into a sealed archive, as a task. Takes `{ "passphrase" }`. Returns `202`; the task result holds the backup. Owner only |
| `GET` | `/api/backups` | List the backups kept on the server, newest first. Owner only |
| `GET` | `/api/backups/{id}/download` | Download a backup archive as `<id>.mbbak`. Owner only |
| `DELETE` | `/api/backups/{id}` | Delete a backup kept on the server. Owner only |

### targets

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/targets` | List off-site targets. Credentials are never returned. Owner only |
| `POST` | `/api/targets` | Add an S3-compatible or SFTP target. Takes its fields, and the credentials are stored as secrets. Owner only |
| `POST` | `/api/targets/test` | Reach a target with the given details, and store nothing. Owner only |
| `GET` | `/api/targets/{id}/check` | Reach a stored target with its own credentials. Owner only |
| `GET` | `/api/targets/{id}/objects` | List the complete packages and backups on a target, newest first. Owner only |
| `DELETE` | `/api/targets/{id}` | Remove a target and its stored credentials. Objects on the target are kept. Owner only |
| `POST` | `/api/targets/{id}/push` | Push a package (`pk_…`) or a backup (`bk_…`) to a target, as a task. Owner only |
| `POST` | `/api/targets/{id}/pull` | Pull a package or a backup from a target, as a task. Owner only |

Targets take the fields of `POST /api/targets`. An S3 target takes `endpoint`, `region`, `bucket`, `accessKeyId` and `secretAccessKey`. An SFTP target takes `host`, `port`, `user`, `privateKey` and `hostKeyFingerprint`. The fingerprint comes from `POST /api/targets/test`, which reports the server's key when the key is not yet known. See [Backups](../admin/backups.md#off-site-targets).

### trash

The recycle bin holds the data of deleted boxes and volumes. Its entries are not checkpoints, so they are not in `GET /api/checkpoints`. These operations are for the owner only.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/trash` | List the recycle bin, newest deletion first. The `trash` array holds each entry's `id`, `hostId`, `kind` (`box` or `volume`), `sourceId`, `sourceName`, `deletedAt`, `expiresAt`, `bytes` and `createdBy` |
| `POST` | `/api/trash/{id}/restore` | Restore an entry as a new box or volume, as a task. Takes `name`, and for a box `cpus` and `memoryMb`, all optional. The entry is removed once the restore has finished |
| `DELETE` | `/api/trash/{id}` | Purge an entry now, as a task. Its data cannot be restored afterwards |

An entry is kept for `TRASH_RETENTION_DAYS` days, see [Configuration](configuration.md#checkpoints). Each delete, restore and purge is recorded as an event: `box.trashed` or `volume.trashed`, `trash.restored` or `trash.purged`.

### templates

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/templates` | List templates |
| `POST` | `/api/templates` | Build a template from a source, as a task. Owner only |
| `POST` | `/api/templates/{ref}/rebuild` | Rebuild a template from the source it was built from, as a task. Owner only |
| `POST` | `/api/templates/{ref}/sync` | Copy a template to another host, as a task. The body is `{ host }`. Owner only |
| `POST` | `/api/images/pull` | Pull an image from its registry, as a task, unless the engine has it. Owner only |
| `POST` | `/api/snapshots/{ref}/promote` | Promote a snapshot to a template |
| `POST` | `/api/boxes/{id}/template` | Save a box as a template |
| `POST` | `/api/templates/base/build` | Build the bundled base template |
| `DELETE` | `/api/templates/{ref}` | Delete a template |

`POST /api/templates` takes `name`, an optional `description` and a `source`. The source's `kind` is `dockerfile` (with `text`), `git` (with `url`, and optional `branch`, `subdir`, `dockerfile` and `secretRef`), `context` (with `url` of a `.tar` or `.tar.gz` archive, and optional `dockerfile`) or `devcontainer` (with `url`, and optional `branch`, `path` and `secretRef`). The task's result holds `template.ref`, such as `minibox-template:node-tools`. `POST /api/images/pull` takes `ref`, such as `node:24-bookworm-slim`, and its task's result holds `image.ref` and `image.id`. See [Templates](../user-guide/templates.md).

`host` names the host an operation runs on. In a body it is the `host` field, as in `POST /api/templates`, `POST /api/images/pull` and `POST /api/templates/{ref}/sync`, where it is the host to copy to. As a query parameter it is `?host=`, as in `POST /api/templates/{ref}/rebuild`, `POST /api/templates/base/build` and `DELETE /api/templates/{ref}`. Without it, a build or a pull runs on `local`, and a rebuild or a delete runs on the first host that holds the template.

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
| `GET` | `/api/tokens` | List agent API tokens |
| `POST` | `/api/tokens` | Create an agent API token |
| `DELETE` | `/api/tokens/{id}` | Revoke an agent API token |

### hosts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/hosts` | List hosts |
| `GET` | `/api/hosts/usage` | Show what each host runs and uses |
| `POST` | `/api/hosts` | Add a host |
| `POST` | `/api/hosts/test` | Test a host connection |
| `POST` | `/api/hosts/pairing` | Create a one-time pairing code for a new agent host `{ "id", "name"? }`. Returns `201` with the code and when it expires |
| `POST` | `/api/hosts/{id}/revoke` | Revoke an agent host. Its agent is disconnected and cannot reconnect |
| `DELETE` | `/api/hosts/{id}` | Remove a host |

An agent connects on its own: it exchanges the pairing code at `POST /api/agent/pair`, then keeps a WebSocket open at `/api/agent/connect`. Both are used by the agent, not by clients. See [Agent](agent.md).

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
