# REST endpoints an agent uses

Base URL: `http://127.0.0.1:3920` (the server's `HOST` and `PORT`). Every request carries `Authorization: Bearer <agent token>`, and every write carries `Content-Type: application/json`.

The complete machine-readable list is [`docs/openapi.json`](https://github.com/ArnoChenFx/minibox/blob/main/docs/openapi.json) (126 paths), and [`docs/reference/api.md`](https://github.com/ArnoChenFx/minibox/blob/main/docs/reference/api.md) describes them by group. Each operation has an `x-scope` (the operation's own scope) and, for the ones MCP also exposes, an `x-mcp` entry.

Conventions in the tables below:

- **Scope** is the operation's `x-scope`. The token scope that allows it is in the [scope table](SKILL.md#tokens-and-least-privilege).
- **If-Match** means the box's current `revision` must be sent in the `If-Match` header (`428` without it, `412` when stale). On MCP and the CLI the same value is the `expectedRevision` argument.
- **202** means the operation returns a `taskId`; poll `GET /api/tasks/{id}`.
- **confirm** means `confirm: true` in the body (or `?confirm=true`) is required; without it the answer is `409 confirmation_required` with `details.preview`.

## Boxes

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/boxes` | `box:read` | `?stats=false` skips usage, `?host=local` |
| `POST` | `/api/boxes` | `box:write` | `name`, `template`, `cpus`, `memoryMb`, `profile`, `egress`, `mounts`, `env`, `idleTimeoutSec`, `ttlSec`, `host`, `tools`, `startupCommand`, `selfToken`, `repo`. A `mounts` entry is `{ volume, path, mode }` for a volume that exists, or `{ role }` (`workspace`, `home`, `tools`, `cache`) for one MiniBox creates for the box; a role the list omits is not created, and `tools` mounts the shared tools volume. `201`; `setup.taskId`, `clone.taskId` |
| `GET` | `/api/boxes/{id}` | `box:read` | The `ETag` is the revision |
| `PATCH` | `/api/boxes/{id}` | `box:write` | If-Match. In place: `name`, `cpus`, `memoryMb`, `pids`, `labels`, `idleTimeoutSec`, `ttlSec` |
| `DELETE` | `/api/boxes/{id}` | `box:delete` | `?deleteVolume=true` (owner or unmodified admin token), `?skipTrash=true` |
| `POST` | `/api/boxes/{id}/start` | `box:write` | |
| `POST` | `/api/boxes/{id}/stop` | `box:write` | Keeps the volumes |
| `POST` | `/api/boxes/{id}/restart` | `box:write` | |
| `PATCH` | `/api/boxes/{id}/resources` | `box:write` | If-Match. `cpus`, `memoryMb`, `pids` |
| `POST` | `/api/boxes/{id}/rebuild` | `box:write` | If-Match, `confirm`. `template`, `mounts`, `env`, `network`, `egress`, `profile`, `safetyCheckpoint` |
| `POST` | `/api/boxes/{id}/move` | `box:write` + every host granted | If-Match, `confirm`, `host`, `via` (`direct` or `checkpoint`, default `direct`). `202` |
| `GET` | `/api/boxes/{id}/logs` | `box:read` | `?tail=` 1–5000 |
| `GET` | `/api/boxes/{id}/stats` | `box:read` | `?history=true` |
| `GET` | `/api/boxes/{id}/ports` | `box:read` | Listening and manually exposed ports, each with `url` |
| `POST` | `/api/boxes/{id}/ports` | `port:expose` | `{ "port": 8000 }` |
| `DELETE` | `/api/boxes/{id}/ports/{port}` | `port:expose` | |
| `DELETE` | `/api/boxes/{id}/self-token` | `box:write` | Revokes the box's own agent token |
| `GET` | `/api/boxes/{id}/staged` | `box:read` | The staged changes, `null` when none |
| `PUT` | `/api/boxes/{id}/staged` | `box:write` | `template`, `mounts`, `env`, `network`, `egress`, `profile` |
| `DELETE` | `/api/boxes/{id}/staged` | `box:write` | Discards them |
| `GET` | `/api/boxes/{id}/staged/preview` | `box:read` | What applying would change |
| `POST` | `/api/boxes/{id}/staged/apply` | owner | If-Match. Rebuilds the box |
| `GET` | `/api/staged` | `box:read` | Every box's staged changes in one read: `{ "staged": [{ "box", "staged" }] }`. Only boxes with something staged are listed |
| `GET` | `/api/boxes/{id}/questions` | `box:read` | Questions the box's agent asked |
| `POST` | `/api/questions/{id}/answer` | `box:write` | `{ "answer" }`. Once only |

## Exec

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/api/boxes/{id}/exec` | `box:exec` | `argv` or `cmd`, `cwd`, `env`, `stdin`, `user`, `timeoutSec`, `background` |
| `GET` | `/api/execs/{execId}` | `box:exec` | `?waitMs=` up to 25000 |
| `POST` | `/api/execs/{execId}/kill` | `box:exec` | |
| `GET` | `/api/execs/{execId}/output` | `box:exec` | The full saved output when the inline one was truncated |

```bash
# foreground, up to 55 s
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"argv":["git","status","--short"],"cwd":"/workspace"}' \
  http://127.0.0.1:3920/api/boxes/my-box/exec

# background, then poll
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":"npm run build > /workspace/build.log 2>&1","background":true,"timeoutSec":900}' \
  http://127.0.0.1:3920/api/boxes/my-box/exec
curl -s -H "Authorization: Bearer $MINIBOX_TOKEN" \
  "http://127.0.0.1:3920/api/execs/ex_01J...?waitMs=25000"
```

## Sessions

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/boxes/{id}/sessions` | `box:session` | Lists sessions with `origin`, `controller`, `takenOver` |
| `POST` | `/api/boxes/{id}/sessions` | `box:session` | `{ "name": "build" }` |
| `GET` | `/api/boxes/{id}/sessions/{name}` | `box:session` | `?lines=` (default 100, max 2000), `?since=<cursor>` |
| `POST` | `/api/boxes/{id}/sessions/{name}/input` | `box:session` | `keys` or `text`, not both |
| `DELETE` | `/api/boxes/{id}/sessions/{name}` | `box:session` | Closes it and stops what runs in it |

## Files (volumes)

All paths are jailed inside the volume. `{id}` is a `vol_…` or a volume name; find it in the box's `mounts`.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/volumes/{id}/files/content` | `files:read` | `?path=`, `?encoding=utf-8\|base64`. Inline cap 1 MiB |
| `PUT` | `/api/volumes/{id}/files/content` | `files:write` | `path`, `content` (at most 1 MiB), `encoding` |
| `GET` | `/api/volumes/{id}/files` | `files:read` | `?path=`, `?maxDepth=` 0–8 (default 2), `?limit=` max 2000 |
| `POST` | `/api/volumes/{id}/files/copy` | `files:write` | `from`, `to` |
| `POST` | `/api/volumes/{id}/files/move` | `files:write` | `from`, `to`; the target must be free |
| `POST` | `/api/volumes/{id}/files/directory` | `files:write` | `path`; parents are created |
| `DELETE` | `/api/volumes/{id}/files` | `files:write` | `?path=`, `?confirm=true`. Not the root |
| `GET` | `/api/volumes/{id}/files/archive` | `files:read` | `?path=`; a tar download |
| `PUT` | `/api/volumes/{id}/files/archive` | `files:write` | A tar upload |
| `PUT` | `/api/volumes/{id}/files/stream` | `files:write` | Raw `application/octet-stream` body with `Content-Length`; `?path=`, `?overwrite=` |
| `GET` | `/api/volumes/{id}/files/stream` | `files:read` | A file, or a folder as a gzip tar |

## Volumes and storage

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/volumes` | `volume:read` | |
| `POST` | `/api/volumes` | `volume:write` | `name`, `pool`, `role`, `confirm`. `201`. Owner or unmodified admin only |
| `GET` | `/api/volumes/{id}` | `volume:read` | Includes the boxes that mount it |
| `DELETE` | `/api/volumes/{id}` | `volume:write` | `?confirm=true`, `?skipTrash=true`. Owner or unmodified admin only |
| `POST` | `/api/volumes/delete` | `volume:delete` | `ids`, `confirm`. One result per volume. Owner or unmodified admin only |
| `POST` | `/api/volumes/prune` | `volume:prune` | `dryRun` (default `true`), `ids`, `olderThan`. Owner or unmodified admin only |
| `POST` | `/api/volumes/{id}/attach` | `volume:attach` (+ `volume:write` for `mode: "rw"`) | If-Match, `confirm`. `box`, `path`, `mode`. Rebuilds the box |
| `POST` | `/api/volumes/{id}/detach` | `volume:attach` | If-Match, `confirm`. `box`, `path`. Rebuilds the box |
| `POST` | `/api/volumes/{id}/usage` | `volume:read` | Refreshes the cached size |
| `PUT` | `/api/volumes/{id}/limits` | owner | Soft and hard limits, and `warn` or `stop` |
| `GET` | `/api/pools` | `pool:read` | Storage pools. Owner or unmodified admin only |
| `PUT` | `/api/pools` | `pool:admin` | Replaces the pool configuration; needs `confirm`. Owner or unmodified admin only |

## Checkpoints

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/checkpoints` | `checkpoint:read` | Every checkpoint |
| `GET` | `/api/checkpoints/{id}` | `checkpoint:read` | |
| `POST` | `/api/boxes/{id}/checkpoints` | `checkpoint:create` | `label`, `reason`, `consistency`, `pinned`, `include`. `202` |
| `POST` | `/api/volumes/{id}/checkpoints` | `checkpoint:create` | `label`, `pinned`. Snapshot one volume on its own, without a box. `202` |
| `POST` | `/api/checkpoints/{id}/fork` | `box:write` | `name`, `cpus`, `memoryMb`, `profile`, `copyHome`, `ttlSec`. `202` |
| `POST` | `/api/boxes/{id}/rollback` | `checkpoint:restore` | If-Match, `confirm`, `checkpoint`. `202` |
| `GET` | `/api/boxes/{id}/rollback` | `checkpoint:read` | The rollback waiting for confirm or undo |
| `GET` | `/api/rollbacks` | `checkpoint:read` | Every waiting rollback in one read: `{ "rollbacks": [{ "box", "rollback" }] }`. Only boxes that wait are listed |
| `POST` | `/api/boxes/{id}/rollback/confirm` | `volume:write` | Deletes the volumes it replaced |
| `POST` | `/api/boxes/{id}/rollback/undo` | `checkpoint:restore` | If-Match. Mounts them again |
| `PATCH` | `/api/checkpoints/{id}` | `checkpoint:write` | Pin or relabel. `202` |
| `DELETE` | `/api/checkpoints/{id}` | `checkpoint:delete` | A pinned checkpoint is refused. `202` |
| `GET` | `/api/checkpoints/usage` | owner | The repository's size against its limit |
| `POST` | `/api/checkpoints/{id}/export` | owner | `{ "passphrase" }`. `202` |
| `POST` | `/api/checkpoints/{id}/copy` | owner | `{ "host" }`. `202` |
| `POST` | `/api/packages/{id}/import` | owner | `{ "passphrase", "host"? }`. `202` |
| `GET`/`PUT`/`DELETE` | `/api/boxes/{id}/checkpoint-schedule` | owner | `everyHours`, or `at` + `timezone` |

## Tools and templates

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/tools` | `box:read` | Catalog with install status |
| `GET` | `/api/tools/catalog` | `box:read` | Catalog only |
| `POST` | `/api/boxes/{id}/tools/install` | `tool:install` | `id` of the tool. `202` |
| `POST` | `/api/boxes/{id}/tools/upgrade` | `tool:install` | `202` |
| `POST` | `/api/boxes/{id}/tools/uninstall` | `tool:install` | `202` |
| `POST` | `/api/boxes/{id}/tools/reconcile` | `tool:install` | Installs what the spec lists. `202` |
| `GET` | `/api/templates` | `box:read` (`template:read`) | |
| `POST` | `/api/boxes/{id}/template` | `tool:install` | Save the box as a template. `202` |
| `POST` | `/api/templates` | owner | `name`, `description`, `source`. `202` |
| `GET` | `/api/templates/{ref}/recipe` | `box:read` (`template:read`) | The source a template rebuilds from, plus its `postCreate` and `forwardPorts` |
| `POST` | `/api/templates/{ref}/fork` | owner | `name`, `description`, `?host=`. `201`; `template.ref`, `template.name` |
| `PATCH` | `/api/templates/{ref}` | `tool:install`; a token only a template it created | `source`, `init` (`postCreate`, `forwardPorts`, or `null`), `description`, `?host=`. `200`; `template.ref`, `template.name`, `template.buildKind`. No build runs |
| `POST` | `/api/templates/{ref}/rebuild` | owner | `?host=`. `202` |
| `POST` | `/api/images/pull` | owner | `ref`. `202` |
| `GET` | `/api/tools/custom` | owner | Custom catalog entries |
| `PUT`/`DELETE` | `/api/tools/custom/{id}` | owner | Create, replace or delete an entry |

## Everything else

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/api/tasks` | `task:read` | |
| `GET` | `/api/tasks/{id}` | `task:read` | Status and result |
| `GET` | `/api/tasks/{id}/events` | `task:read` | Server-sent events |
| `POST` | `/api/tasks/{id}/cancel` | owner | A queued task only |
| `GET` | `/api/events` | `events:read` | `?op=`, `?box=`, `?status=`, `?since=`, `?cursor=`, `?limit=` |
| `GET` | `/api/events/stream` | `events:read` | Server-sent events; send `Last-Event-ID` to resume |
| `GET` | `/api/boxes/{id}/logs/stream` | `box:read` | Server-sent events; `?tail=` |
| `GET` | `/api/overview` | owner | What agents are doing and what needs attention |
| `GET` | `/api/hosts`, `/api/hosts/usage`, `/api/hosts/{id}/disk` | owner | Hosts, with the labels each one carries, and what a host's engine holds (`docker system df`). A host is addressed by `id` everywhere; `name` is only the label the console shows, and no two hosts may share one |
| `POST` | `/api/hosts/{id}/forward` | owner | Adds the `FORWARD` rule the overview's "proxy-only boxes have no internet" item offers, after the owner confirms it. Returns the reading taken right after |
| `POST` | `/api/hosts/{id}/force-remove` | owner | `confirm`. Forgets a lost, offline host's records: its boxes, its volume records (the shared tools volume too) and its checkpoint records. No engine is contacted. Without `confirm: true` nothing changes and a `409` `confirmation_required` preview lists them |
| `PATCH` | `/api/hosts/{id}` | owner | `labels`. The local host included |
| `GET` | `/api/secrets` | owner | Secret names, never values |
| `GET` | `/api/trash` | owner | The recycle bin |
| `POST` | `/api/trash/{id}/restore` | owner | `202` |
| `DELETE` | `/api/trash/{id}` | owner | `202` |
| `POST` | `/api/trash/empty` | owner | `confirm`. One result per entry |
| `GET` | `/api/tokens` | owner | Agent tokens, never their secrets |
| `POST` | `/api/tokens` | owner | `name`, `preset` or `scopes`, `boxes`, `volumes`, `hosts`, `quotas`, `expiresInSec`. `201`, secret once |
| `DELETE` | `/api/tokens/{id}` | owner | Revoke. `?deleteCreated=true` also deletes the boxes it created |
| `GET` | `/api/notify/channels` | owner | `hasSecret` only, never the secret |
| `PUT` | `/api/notify/channels/{id}` | owner | Create or change a channel |
| `POST` | `/api/backups` | owner | `{ "passphrase" }`. `202` |
| `GET`/`PUT`/`DELETE` | `/api/backups/schedule` | owner | `everyHours`, or `at` + `timezone`. One schedule for the instance |
| `GET` | `/api/targets` | owner | Off-site targets |

Not in the OpenAPI document: `POST /api/packages` (raw `.mbckpt` upload), `GET /api/packages/{id}/download`, the SSE streams above, the terminal WebSocket at `/api/boxes/{id}/terminal`, the SSH WebSocket at `/api/ssh/{box}`, and the preview routes `/box/{name-or-id}/{port}/…`.

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `validation_failed` | 400 | A field is invalid; `details.field` names it |
| `unauthorized` | 401 | No valid credential |
| `forbidden` | 403 | The scope is missing, or the object is outside the token's grants |
| `not_found` | 404 | No such box, volume, exec, task or checkpoint |
| `conflict` | 409 | The state does not allow it (already running, name taken, exec already exited) |
| `confirmation_required` | 409 | Send `confirm: true`; `details.preview` shows what would change |
| `volume_over_limit` | 409 | A mounted volume is over its hard limit |
| `precondition_failed` | 412 | Stale `If-Match` |
| `precondition_required` | 428 | Missing `If-Match` |
| `too_many_requests` | 429 | A rate or background-exec limit. Retry later |
| `insufficient_capacity` | 422 | The host has no room for the request |
| `docker_error`, `bad_gateway` | 502 | The engine or an upstream refused |
| `docker_unavailable` | 503 | The engine or a storage pool is unreachable |
| `insufficient_storage` | 507 | The host disk is below its free-space minimum |
