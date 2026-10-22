# REST API reference

Every MiniBox operation is available over a JSON REST API under `/api`. The console, the [CLI](cli.md) and the [MCP tools](mcp.md) use the same operations.

The full machine-readable description is the OpenAPI 3.1 document in [`openapi.json`](../openapi.json). Import it into any OpenAPI tool to generate a client. The document describes 84 operations in 15 groups.

## Authentication

Send one of these with each request:

- The session cookie that `POST /api/auth/login` sets in a browser.
- An `Authorization: Bearer` header. The value is the access key, or an agent token (`mbx_…`). Create agent tokens in **Settings** or with `POST /api/tokens`.

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
| `checkpoint:usage`, `checkpoint:export`, `checkpoint:import`, `checkpoint:schedule`, `host:manage`, `pool:read`, `pool:admin`, `secret:manage`, `task:write`, `template:build`, `token:manage`, `tool:custom` | None. Only the access key can call these. |

The scope check comes first. The token's box, volume and host grants, its quotas and the operation's own rules then apply too. `box:ssh` is a token scope with no operation of its own: it allows the SSH gateway. `secret:use` also allows a create or rebuild that refers to a secret.

## Requests

- Send JSON bodies, and set `Content-Type: application/json` on every write. A write with another content type gets `415`. A write with neither a body nor a `Content-Type` is accepted. The exceptions are the package upload, `POST /api/packages`, which takes the raw bytes of a `.mbckpt` file, and the volume file upload, `PUT /api/volumes/{id}/files/stream`, which takes the raw bytes of one file. Both take `application/octet-stream` and need a `Content-Length` header, which gets `411` when it is missing.
- Cross-site browser requests that upgrade a WebSocket, change state through the API, or read the event or box log streams are refused with `403`. See [Security](../admin/security.md).
- A request may send an `X-Minibox-Run` header that names the client session it belongs to. The audit events of one session share this value. It takes 1 to 64 letters, digits, dots, colons, underscores or hyphens, and starts with a letter or digit. Any other value gets `400`.
- Some writes need the box's current revision. Send it in the `If-Match` header. A missing header gets `428`, a stale revision gets `412`, and a malformed value gets `400`. The box's `revision` field shows the current value.

## Long-running operations

Some operations take a while, such as template builds, checkpoints, exports, imports, forks, rollbacks and tool installs. They return `202` with a `taskId` at once. The work continues on the server.

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
| `precondition_failed` | 412 | The `If-Match` revision is stale |
| `unsupported_media_type` | 415 | The `Content-Type` is not JSON |
| `insufficient_capacity` | 422 | The host does not have enough capacity for the request |
| `precondition_required` | 428 | A required `If-Match` header is missing |
| `too_many_requests` | 429 | A limit was reached. Try again later. |
| `docker_error` | 502 | The Docker engine returned an error |
| `bad_gateway` | 502 | A storage server or another upstream refused the request |
| `docker_unavailable` | 503 | The Docker engine, or a storage pool, cannot be reached |

Error messages are in English. The `code` is stable, so scripts should check it rather than the message.

## Operations that are not in the OpenAPI document

These are streams, sockets and file routes. They are not described in the OpenAPI document.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/stream` | Live events, as server-sent events. Accepts the same filters as `GET /api/events`. A stream without filters also carries live state. |
| `GET` | `/api/boxes/{id}/logs/stream?tail=N` | A box's log, as server-sent events. Sends the newest `N` lines first, then new lines as they arrive. |
| `GET` | `/api/tasks/{id}/events` | A task's progress, as server-sent events |
| `GET` | `/api/boxes/{id}/terminal` | A WebSocket for a terminal in a box. The `session` query parameter names the tmux session to attach to. Used by the console. A Bearer caller can read the output, but its input is refused, and its terminal needs tmux 3.2 or later in the box. |
| `GET` | `/api/ssh/{box}` | A WebSocket that carries one SSH connection to a box. Used by `ssh-proxy`. With a plain GET, it runs the checks and returns `204`, or the refusal as JSON. |
| `GET` | `/api/ssh/host-key` | The SSH gateway's host key |
| `POST` | `/mcp` | The MCP endpoint. See [MCP tools](mcp.md). |
| `GET` | `/box/{name-or-id}/{port}/…` | Port preview. Proxies HTTP and WebSocket to a port in a box. See [Port preview](../user-guide/port-preview.md). |
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
| `POST` | `/api/boxes` | Create and start a box |
| `GET` | `/api/boxes/{id}` | Get one box |
| `PATCH` | `/api/boxes/{id}` | Update a box in place |
| `DELETE` | `/api/boxes/{id}` | Delete a box |
| `POST` | `/api/boxes/{id}/start` | Start a box |
| `POST` | `/api/boxes/{id}/stop` | Stop a box |
| `POST` | `/api/boxes/{id}/restart` | Restart a box |
| `PATCH` | `/api/boxes/{id}/resources` | Change the CPU, memory or process limit of a box |
| `POST` | `/api/boxes/{id}/rebuild` | Rebuild a box from its spec |
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
| `POST` | `/api/boxes/{id}/ports` | Remember a port for path-mode preview |
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
| `DELETE` | `/api/volumes/{id}` | Delete a volume |
| `POST` | `/api/volumes/{id}/attach` | Mount a volume on a box |
| `POST` | `/api/volumes/{id}/detach` | Unmount a volume from a box |
| `POST` | `/api/volumes/{id}/usage` | Measure a volume |
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
| `GET` | `/api/checkpoints` | List checkpoints |
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

### templates

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/templates` | List templates |
| `POST` | `/api/snapshots/{ref}/promote` | Promote a snapshot to a template |
| `POST` | `/api/boxes/{id}/template` | Save a box as a template |
| `POST` | `/api/templates/base/build` | Build the bundled base template |
| `DELETE` | `/api/templates/{ref}` | Delete a template |

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
