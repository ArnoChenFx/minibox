# Agents

`POST /mcp` is a Streamable HTTP MCP server. Send `Authorization: Bearer` and the access key. A browser session cookie is refused. `GET /mcp` is not an event stream (`405`, `Allow: POST, DELETE`). `DELETE /mcp` closes the session named by `Mcp-Session-Id`. A wrong Bearer key counts toward the same login limit as a wrong login key, so after 10 failures from one address within 5 minutes the next one gets `429`.

> **Warning: `/mcp` authenticates with the main access key, which grants full owner access.** Any client that holds the key can call every tool in the toolsets it asks for, including `exec` as root in a box that is not `strict`, `delete_box` and `rebuild_box`. There are no scoped tokens yet (#13). Give an agent the key only if you accept that, keep it out of prompts, logs and repositories, and change `ACCESS_KEY` if it leaks.

`?toolsets=` selects toolsets: `core`, `session`, `network`, `storage`, `tools`, `meta` and `rebuild`. The query wins over the session. The default is `core,meta`. `rebuild_box` is in the `rebuild` toolset, so it is not in the default list: use `/mcp?toolsets=rebuild`, or `/mcp?toolsets=core,meta,rebuild`, to enable it. The design catalog is 27 tools, 15 of them in the default toolsets, and it does not list `rebuild_box`. This server exposes the tools that exist: `list_boxes`, `get_box`, `create_box`, `update_box`, `box_action`, `delete_box`, `exec`, `exec_get` and `exec_kill` in the default toolsets (9 tools), and `rebuild_box` in `rebuild`. `get_activity` and `task_wait` are not implemented yet. The other toolsets are accepted and currently add none. File tools are not implemented.

`minibox mcp` proxies newline-delimited JSON-RPC from stdio to `/mcp`. Build the binary with `bun run build:cli`.

The `initialize` result includes the block below. [`README.md`](../README.md) includes the same text, so an agent can paste it into `AGENTS.md`.

## MiniBox

Use the MiniBox MCP server (`/mcp`, Bearer access key) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box, which changes its revision. Read the revision again before an update that sends expectedRevision.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace. A strict box allows only dev or 1000 as the user. The box needs /bin/sh, cat, rm and sleep.
- Pass secrets in env, not in argv or cmd. The audit log keeps commands and argv, but never env values.
- The result includes status, exitCode, stdout, stderr, truncated and durationMs. A non-zero exit code is the program's status.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When truncated is true, outputRef names the rest: GET /api/execs/{execId}/output.
- A foreground exec may set timeoutSec up to 55. For a longer command, use exec with background true and a larger timeoutSec (up to 3600), then exec_get with waitMs (max 25000). exec_kill stops the process tree.
- exec can read and write every volume mounted on that box.
- rebuild_box is in the rebuild toolset (`/mcp?toolsets=rebuild`) and needs confirm true.
- session_start, session_send and session_read drive a tmux session in the box. They are in the session toolset (`/mcp?toolsets=core,session`). A session keeps running after you disconnect. Use exec for one-off commands and a session for long-running or interactive programs. Listing and closing sessions are in the REST API and the CLI only.
- A session started through MCP has origin agent. A person can take it over in the console. While they hold it, session_send fails with taken_over and retryable true: wait a little, read the session with session_read, and send again. session_read still works during a takeover.
- session_read returns lines and a cursor. Pass the newest cursor as since to read only what is new. reset true means the screen was redrawn, and lines is the current window.
- session_send takes keys (tmux names such as Enter, Tab, Escape or C-c) or text, but not both. The audit log keeps the counts, never the input.
- File tools are not available yet. The default toolsets are core and meta. The design catalog is 27 tools, 15 of them in the default toolsets; this server exposes the tools that are implemented.

## Exec

`exec` means the caller can read and write every volume mounted on that box. Finer `files:*` scopes only matter for a token that does not have `exec`. Attaching a volume requires `volume:attach` (#13, not enforced yet).

A foreground call may set `timeoutSec` up to 55 seconds, which stays under the server's 60-second idle timeout. Longer commands use `background: true` with a larger `timeoutSec` (up to 3600) and `exec_get`. At most 8 background execs run per box and 64 across MiniBox; a call over either limit gets `429` and does not start a stopped box. A timeout stops the process tree and returns `timedOut: true`, with the exit code from `exec.inspect`, or 137 when the engine does not report one. If the stop fails, the exec stays `running`, a foreground call returns with `timedOut: true`, the stop is retried after a growing delay, and `exec_kill` can retry too.

Stopping a box is not required before `exec`: a stopped box is started, and that changes its revision, so read the revision again before an update that sends `expectedRevision`. Idle timeout and TTL remain #12.

Commands and argv are written to the audit log, so pass secrets in `env`, not in `argv` or `cmd`. Under the `strict` profile exec runs only as `dev` or `1000`. Other profiles may run as `root`, and the audit marks those runs `privileged: true`. The `X-Minibox-Client` header does not change the audit source: REST calls are recorded as `rest` and MCP calls as `mcp`.

The box needs `/bin/sh`, `cat`, `rm` and `sleep`: the exec wrapper and the process-tree stop run them inside the box.

File read and write, including archive access and a helper container for a stopped box, are not in this server. They follow Volume (#24).
