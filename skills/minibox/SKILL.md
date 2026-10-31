---
name: minibox
description: Use MiniBox boxes over MCP or the REST API to run commands, read and write files, preview ports and take checkpoints. Load this when a task should run in a sandboxed MiniBox workspace, or when MINIBOX_URL and a MiniBox agent token (mbx_…) are available.
---

# MiniBox

MiniBox runs long-lived Docker **boxes**: isolated workspaces with a persistent `/workspace`, their own processes and CPU/memory limits. Every console action is one operation behind two interfaces: the MCP endpoint at `/mcp` and the JSON REST API under `/api`. The `minibox` CLI calls the same operations.

Use it to do the real work somewhere other than the host: build, test, install, run a server, keep a long-running process.

## 1. Connect

Use an **agent token** (`mbx_…`). Never the owner access key: `/mcp` refuses it with `401` unless the server sets `MCP_ALLOW_OWNER_KEY=true`, and the key can do anything on every box. Create a token in **Settings → Agent API tokens** (presets: `readonly`, `operator`, `sandboxed-agent`, `admin`) or with `minibox token create <name>`. Only the owner can create tokens, and a token cannot create tokens.

Below, `MINIBOX_URL` is the server address (default `http://127.0.0.1:3920`) and `MINIBOX_TOKEN` the agent token.

### MCP: the agent calls tools

`POST /mcp` is Streamable HTTP JSON-RPC. `GET /mcp` answers `405`; there is no server-to-client stream. A `Bearer` credential is required — a browser cookie is not accepted.

```bash
# 1. Initialize. The response header Mcp-Session-Id names the session; reuse it on every later call.
curl -s "http://127.0.0.1:3920/mcp?toolsets=core,meta,session" \
  -H "Authorization: Bearer $MINIBOX_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}'

# 2. List the tools this token may use in those toolsets.
curl -s "http://127.0.0.1:3920/mcp?toolsets=core,meta,session" \
  -H "Authorization: Bearer $MINIBOX_TOKEN" -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Call one.
curl -s "http://127.0.0.1:3920/mcp?toolsets=core,meta,session" \
  -H "Authorization: Bearer $MINIBOX_TOKEN" -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"exec","arguments":{"id":"my-box","cmd":"npm test","background":true,"timeoutSec":600}}}'
```

- `toolsets` is a comma-separated query parameter. The default is `core,meta`; an unknown name is `400 validation_failed`. A call to a tool whose toolset is not enabled returns a tool error naming the toolset.
- `tools/list` offers only the tools the token's scopes allow. A tool that is missing is a scope or toolset problem, not a server problem.
- A successful result carries `result.structuredContent` (the operation's JSON output) and `result.content[0].text` (the same JSON as a string). A failure sets `result.isError: true` and the text is `{ code, message, hint, retryable, details? }` — the same shape REST uses, and nothing changed.
- `DELETE /mcp` with `Mcp-Session-Id` closes the session. A notification (a message with no `id`) answers `202`.
- The `Mcp-Session-Id` you send belongs to the token that opened it. A call with another token's or a closed session id is answered as if no session were named: it uses the URL's `toolsets` or the default. Re-initialize if tools disappear.

### REST: scripts and curl

```bash
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" http://127.0.0.1:3920/api/boxes

curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"task-1","cpus":2,"memoryMb":4096}' http://127.0.0.1:3920/api/boxes
```

- Writes need `Content-Type: application/json` (`415` otherwise; only the two raw uploads take `application/octet-stream`). Errors are `{ "error": { code, message, hint, retryable, details } }`; branch on `code`, not on the message.
- A box id is a name, a container name, a container id or a stable id (`bx_…`). A volume id is a `vol_…` or a volume name.
- Writes that change a box's spec need the current `revision` in `If-Match`: `428 precondition_required` without it, `412 precondition_failed` when stale, `400` when malformed. Re-read the box after anything that restarts or resizes it.
- Long operations answer `202` with a `taskId`. Poll `GET /api/tasks/{id}` (or stream `GET /api/tasks/{id}/events`) until the status is `succeeded`, `failed`, `cancelled` or `interrupted`.

### Which one to use

- **MCP** when the agent drives itself. Tools are filtered per scope, and arguments are the operation's fields.
- **REST** for scripts and curl, and for what MCP does not expose: checkpoints (take, list, duplicate, roll back), session list and close, box logs and stats, tasks, tokens, raw file streaming, event streams, and owner-only administration.

## 2. Core operations

| Goal | MCP tool (toolset) | REST |
|---|---|---|
| List boxes | `list_boxes` (core) | `GET /api/boxes` (`?stats=false` skips the usage) |
| Create and start | `create_box` (core) | `POST /api/boxes` |
| One box, revision | `get_box` (core) | `GET /api/boxes/{id}` |
| Start / stop / restart | `box_action` (core) | `POST /api/boxes/{id}/start`, `/stop`, `/restart` |
| Resize, rename, TTL | `update_box` (core) | `PATCH /api/boxes/{id}` (If-Match) |
| Delete | `delete_box` (core) | `DELETE /api/boxes/{id}?deleteVolume=true` |
| Run a command | `exec` (core) | `POST /api/boxes/{id}/exec` |
| Poll / kill / full output | `exec_get`, `exec_kill` (core) | `GET /api/execs/{execId}?waitMs=`, `POST /api/execs/{execId}/kill`, `GET /api/execs/{execId}/output` |
| Terminal session | `session_start`, `session_send`, `session_read` (session) | `POST /api/boxes/{id}/sessions`, `/sessions/{name}/input`, `GET /api/boxes/{id}/sessions/{name}` |
| List / close sessions | — | `GET /api/boxes/{id}/sessions`, `DELETE /api/boxes/{id}/sessions/{name}` |
| Read, write, list, copy files | `read_file`, `write_file`, `list_files`, `copy_files`, `upload_files` (core) | `/api/volumes/{id}/files…` |
| Preview ports | `list_ports`, `expose_port` (network) | `GET`, `POST /api/boxes/{id}/ports` |
| Checkpoints | — (REST only) | `/api/boxes/{id}/checkpoints`, `/api/checkpoints/{id}/fork`, `/api/boxes/{id}/rollback` |
| Logs and stats | — | `GET /api/boxes/{id}/logs?tail=`, `GET /api/boxes/{id}/stats` |
| Rebuild / move a box | `rebuild_box` (rebuild), `move_box` (move) | `POST /api/boxes/{id}/rebuild`, `/move` |
| Volumes and pools | storage toolset | `/api/volumes`, `/api/pools` |
| Snapshot one volume | `snapshot_volume` (storage) | `POST /api/volumes/{id}/checkpoints` |
| Startup command | `get_/set_/delete_/run_startup_command` (core) | `/api/boxes/{id}/startup-command` |

The full endpoint table is in [rest-endpoints.md](rest-endpoints.md); the tool list per toolset is in [mcp-toolsets.md](mcp-toolsets.md).

### Run a command

`exec` takes `argv` (run directly, no shell) **or** `cmd` (through `/bin/sh -c`), never both. Defaults: user `dev`, directory `/workspace`, `timeoutSec` 30. `env` is a map of names to values — put secrets there, never in `cmd`/`argv`, because the audit log keeps the command and argv but not the env values.

```json
{"name":"exec","arguments":{"id":"my-box","argv":["npm","test"],"cwd":"/workspace/app","timeoutSec":40}}
```

- A foreground call may use `timeoutSec` up to **55**. For anything longer set `"background": true` (up to 3600) and poll with `exec_get` (`waitMs` up to 25000) or `GET /api/execs/{execId}?waitMs=`.
- At most 8 background execs run per box and 64 per server; over that you get `429 too_many_requests`.
- The result is `{ status, exitCode, stdout, stderr, truncated, durationMs, timedOut, outputRef, execId }`. A non-zero `exitCode` is the program's own status, not a MiniBox failure.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When `truncated` is true, `outputRef` names the rest: `GET /api/execs/{execId}/output`.
- `exec` starts a stopped box, which raises its `revision`; `exec` on a box whose TTL has passed fails with `box_ttl_expired`.
- Commands can read and write every volume the box mounts, so `exec` replaces `files:*` when you have it.

### Terminal sessions

Use `exec` for one-off commands and a session for interactive or long-running programs (`npm run dev`, a REPL, a TUI). A session keeps running after you disconnect and ends when the box stops; a box holds at most 16 sessions, then `session_start` fails with `429`.

- `session_send` takes `keys` (tmux names: `Enter`, `Tab`, `Escape`, `C-c`, `Up`) or `text`, not both.
- `session_read` returns `lines` and a `cursor`. Pass the newest cursor back as `since` to read only what is new. `reset: true` means the screen was redrawn and `lines` is the current window.
- A person can take the session over in the console. Then `session_send` fails with `taken_over` and `retryable: true`: wait, `session_read`, then send again. Reads keep working.

### Files: the volume API, not the box

File operations act on **volumes**, so they work while the box is stopped. Find the volume id in the box's `mounts` (`volumeId`, with `role` `workspace`, `home`, `tools` or `cache`).

```bash
# read, write, list (path is jailed inside the volume)
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" \
  "http://127.0.0.1:3920/api/volumes/vol_xxx/files/content?path=/app/package.json"
curl -s -X PUT -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"path":"/app/hello.txt","content":"hi\n"}' \
  "http://127.0.0.1:3920/api/volumes/vol_xxx/files/content"

# upload a large file as a raw body (needs Content-Length; overwrite defaults to false)
curl -s -X PUT -H "Authorization: Bearer $MINIBOX_TOKEN" \
  -H 'Content-Type: application/octet-stream' --data-binary @dist.tar.gz \
  "http://127.0.0.1:3920/api/volumes/vol_xxx/files/stream?path=/app/dist.tar.gz&overwrite=true"
```

- `write_file` / `PUT …/files/content` takes `content` as text (`encoding: "utf-8"`, the default) or base64 (`encoding: "base64"`) and stamps uid/gid 1000 (`dev`). The content is at most 1 MiB.
- `upload_files` takes a base64 tar of at most 2 MiB. For anything bigger use `PUT …/files/stream` or `minibox upload`.
- `list_files` caps entries with `limit` (default 500, max 2000) and does not follow symlinks. `DELETE …/files?path=…&confirm=true` is needed to remove a path; the volume root cannot be deleted.

### Ports and preview

```json
{"name":"expose_port","arguments":{"id":"my-box","port":8000}}
```

`expose_port` (needs `port:expose`) only remembers the port. It publishes nothing on the host. The returned `url` is a link a **signed-in browser** opens: path mode `/box/<name>/<port>/`, or the port's own host when `PREVIEW_BASE_DOMAIN` is set. `list_ports` (needs `box:read`) also reports ports found listening in the box, so a server on `127.0.0.1:8000` shows up without exposing it. A preview needs `python3` in the box (the base template has it).

### Checkpoints (REST only)

MCP has no checkpoint tools. A token needs `checkpoint:create` to take one and `checkpoint:restore` to roll back; listing checkpoints and reading a rollback also pass with `box:read`.

```bash
# take one: 202 + taskId, then poll the task; the checkpoint is in the task result
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"before-upgrade","reason":"manual","consistency":"live"}' \
  http://127.0.0.1:3920/api/boxes/my-box/checkpoints

# list, make a new box from one, roll the box back (rollback needs If-Match and confirm)
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" http://127.0.0.1:3920/api/checkpoints
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"my-box-fork"}' http://127.0.0.1:3920/api/checkpoints/ck_xxx/fork
```

`consistency` is `live` (default, crash-consistent), `pause` (freeze the box) or `stop` (stop it and start it again). Export, import, copy and schedule are owner-only.

A single volume can be snapshotted without a box, which is what the storage page's **Snapshot** button does for an independent volume. The record names no box, so it can be pinned and deleted, but not duplicated, exported, copied or rolled back (each is refused with its reason):

```bash
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"before-the-migration","pinned":true}' \
  http://127.0.0.1:3920/api/volumes/vol_xxx/checkpoints
```

### Tokens and least privilege

Give the token the fewest scopes that do the job. The operation's own scope (in `openapi.json` as `x-scope`) is not a token scope; a token passes when it holds one of these:

| You need to | Token scope |
|---|---|
| See boxes, tasks, templates, events | `box:read` |
| Create, update, start, stop, rebuild a box | `box:write` |
| Delete a box | `box:delete` |
| Run commands and drive sessions | `exec` |
| Read / write files in volumes | `files:read` / `files:write` |
| Expose a preview port (listing ports needs only `box:read`) | `port:expose` |
| Take checkpoints / roll back | `checkpoint:create` / `checkpoint:restore` |
| Volumes | `volume:read`, `volume:write`, `volume:attach`; batch delete also needs `volume:delete` |
| Install and manage tools | `tool:install` |
| Use a host secret or a box's startup command | `secret:use` (+ `exec` to set, delete or run it) |
| Delete without the recycle bin | `trash:skip` |

Storage pool selection/configuration, explicit volume creation/deletion and orphan pruning require the owner or an unmodified admin token. Volume scopes alone do not grant this identity.

A `create_box` that mounts an existing volume needs `volume:attach`, and a read-write mount — or the workspace, home and cache volumes a new box creates — needs `volume:write` too.

Owner-only, no token scope reaches them: tokens, hosts, notification channels, template builds and image pulls, the recycle bin, backups and off-site targets, custom tools, task cancellation, checkpoint export/import/copy/schedule, volume limits. A token also sees only the boxes, volumes and hosts it was granted, and only the boxes it created by default.

## 3. Common pitfalls

1. **`forbidden` / a tool that is missing.** The token lacks the scope, or the box is outside its grants. `tools/list` hides the tools the token may not use, and calling one anyway returns a tool error with the code `forbidden`. A box's self token gets `403` on everything but the `self` operations of its own box.
2. **`401` on `/mcp` with the access key.** That is the default (`MCP_ALLOW_OWNER_KEY=false`). Use an `mbx_…` token.
3. **A toolset that is not enabled.** `rebuild_box` needs `?toolsets=rebuild`, `move_box` needs `?toolsets=move`, sessions need `?toolsets=core,session`, ports need `network`, volumes need `storage`. The error names the missing toolset.
4. **Truncated exec output.** Inline output is capped; when `truncated` is true the rest is at `GET /api/execs/{execId}/output`. Save big output to a file in the volume instead of reading it back through a tool.
5. **A foreground command that outlives 55 seconds.** It is refused (`validation_failed` on `timeoutSec`) or times out with `timedOut: true`. Use `background: true` and poll.
6. **`412 precondition_failed` / `428 precondition_required`.** Send the box's current `revision` in `If-Match` (`expectedRevision` on MCP). Any `exec`, start, stop or resize changes it, so read the box again before the next write.
7. **`409 confirmation_required`.** Destructive operations change nothing until they are confirmed. Read `details.preview`, then resend with `confirm: true` (`?confirm=true` for `DELETE /api/volumes/{id}/files`). This covers volume create/delete/attach/detach, `replace_pools`, `rebuild_box`, `move_box`, `empty_trash`, a rollback, and a file delete. `attach_volume` and `detach_volume` also need `expectedRevision`, because they rebuild the box.
8. **The preview URL is not an API.** It is a browser sign-in link for a human. Do not call it from a script expecting JSON.
9. **`write_file` takes a volume id, not a box id.** Look in the box's `mounts`, and remember paths are jailed inside that volume.
10. **`429 too_many_requests`.** Background exec limits (8 per box, 64 per server), a token quota (`rateLimit` requests per `rateWindowSec`, which the `sandboxed-agent` preset sets to 60 a minute), or a self token's 60 calls a minute. Back off; the error is `retryable`.
11. **A deleted box or volume is not gone.** Its data goes to the recycle bin unless `skipTrash` is set (owner, or the `trash:skip` scope). Restoring is owner-only.
12. **A box's own agent.** It reads its token from `/run/minibox/self-token`, is offered only `get_info`, `checkpoint`, `get_task`, `ask_human`, `get_question` and `report_status`, reaches only its own box, and needs `MINIBOX_URL` set to an address the box can reach.

## 4. Reference files

- [rest-endpoints.md](rest-endpoints.md): the endpoints an agent actually uses, with scopes, bodies and query parameters.
- [mcp-toolsets.md](mcp-toolsets.md): every toolset and tool, and what each tool needs.

The repository documentation has the full detail (absolute links — this skill may be installed outside the repository): [MCP tools](https://github.com/ArnoChenFx/minibox/blob/main/docs/reference/mcp.md), [REST API](https://github.com/ArnoChenFx/minibox/blob/main/docs/reference/api.md), [OpenAPI document](https://github.com/ArnoChenFx/minibox/blob/main/docs/openapi.json), [connecting AI agents](https://github.com/ArnoChenFx/minibox/blob/main/docs/user-guide/agents.md), [CLI](https://github.com/ArnoChenFx/minibox/blob/main/docs/reference/cli.md).

## 5. Fallback: the CLI

When a shell is available, the `minibox` command does the same work and needs only `MINIBOX_URL` and `MINIBOX_ACCESS_KEY` (the token is fine):

```bash
minibox box ls
minibox box create task-1 --cpus 2 --memory 4096
minibox exec task-1 -- npm test
minibox exec task-1 --background --timeout 600 -- npm run build   # prints the exec id; poll it over REST or MCP
minibox files ls vol_xxx --path /
minibox mcp          # exposes /mcp over stdin/stdout for a client that starts a command
```

`minibox <command> --help` lists the flags, and `--json` prints the raw API response.
