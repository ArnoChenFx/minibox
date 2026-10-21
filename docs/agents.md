# Agents

`POST /mcp` is a Streamable HTTP MCP server. Send `Authorization: Bearer` and the access key. A browser session cookie is refused. `GET /mcp` is not an event stream (`405`, `Allow: POST, DELETE`). `DELETE /mcp` closes the session named by `Mcp-Session-Id`. A wrong Bearer key counts toward the same login limit as a wrong login key, so after 10 failures from one address within 5 minutes the next one gets `429`.

> **Warning: `/mcp` authenticates with the main access key, which grants full owner access.** Any client that holds the key can call every tool in the toolsets it asks for, including `exec` as root in a box that is not `strict`, `delete_box` and `rebuild_box`. There are no scoped tokens yet (#13). Give an agent the key only if you accept that, keep it out of prompts, logs and repositories, and change `ACCESS_KEY` if it leaks.

`?toolsets=` selects toolsets: `core`, `session`, `network`, `storage`, `tools`, `meta` and `rebuild`. The query wins over the session. The default is `core,meta`. `rebuild_box` is in the `rebuild` toolset, so it is not in the default list: use `/mcp?toolsets=rebuild`, or `/mcp?toolsets=core,meta,rebuild`, to enable it. The design catalog is 27 tools, 15 of them in the default toolsets, and it does not list `rebuild_box`. This server exposes the tools that exist: `list_boxes`, `get_box`, `create_box`, `update_box`, `box_action`, `delete_box`, `exec`, `exec_get` and `exec_kill` in the default toolsets (9 tools), `rebuild_box` in `rebuild`, and `session_start`, `session_send` and `session_read` in `session` (13 tools in all). `get_activity` and `task_wait` are not implemented yet. `network`, `storage`, `tools` and `meta` are accepted and add no tools for now. File tools are not implemented.

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

## Sessions

A session is a named tmux session in the box. Agents drive it with `session_start`, `session_send` and `session_read`, or with `POST /api/boxes/:id/sessions`, and the console opens a terminal on the same sessions. A session runs as `dev` in every profile, including `strict`, and keeps running after you disconnect. It ends when it is closed or the box stops. Use exec for a one-off command, and a session for a long-running program or one that needs input.

- **Origin and controller.** `origin` is `agent` for a session the API or MCP created, and `human` for one the console created. `controller` says who may type now: `agent` or `human`. A session starts under the controller that matches its origin, so a session the console started stays with the person until they return it.
- **Takeover.** In the console, a person can take an agent's session over. Until they return it, `session_send` fails with `taken_over` (409, `retryable: true`), and so does closing the session, because only the console can close a session a person holds. The message names the session. Read it with `session_read`, wait a little, and send again. `session_read` still works during a takeover.
- **What the lock does not cover.** The lock applies to the session API and the terminal, not to `exec`. An agent that runs `exec` in the box as `dev`, the user the tmux server runs as, can still reach the session with `tmux send-keys` or `tmux kill-session`, whoever holds it. A takeover asks agents to stop; it is not a sandbox. `exec` as root is not limited by it either.
- **Return.** The person returns the session with the console's "Return to agent" button. It also returns by itself after `SESSION_TAKEOVER_IDLE_SEC` seconds without their input: 300 by default, and `0` turns this off. With `0`, a takeover lasts until it is returned, even if the page closes. A restart of MiniBox resets every session to the controller its origin implies.
- **Reading.** `session_read` returns `lines` (the end of the screen and its history: 100 by default, at most 2000), `truncated`, `controller` and `cursor`. It looks back at most 4000 lines of history. Pass the newest `cursor` as `since` to get only the lines that are new. `reset: true` means the screen was redrawn, the cursor is not the newest one, or MiniBox restarted. `lines` is then the current window.
- **Sending.** `session_send` takes exactly one of `keys` (tmux key names in order, such as `Enter`, `Tab`, `Escape`, `C-c` or `Up`, at most 32) and `text` (literal UTF-8, at most 16 KiB, where a newline is Enter for the shell). The audit log keeps the number of keys and bytes, never the input.
- **Terminal socket.** `GET /api/boxes/:id/terminal?session=NAME` is a WebSocket that attaches to one session. Only a browser session can type, take over or return it. A Bearer caller reads the output, and its input gets a `forbidden` error frame (`terminal_read_only`). Its tmux client is read-only and ignores the window size, and its `resize` frames are dropped, so it never changes the window size. That attach needs tmux 3.2 or later in the box.
- **Limits.** A box holds at most 16 sessions, and a session has at most 8 terminals open at once, counting one that is starting. Bearer terminals may hold at most 6 of those 8, and the other 2 are kept for the browser console. Past any of these limits the call fails with `too_many_requests` (429) and a hint: close one, then try again. The 16 counts every tmux session in the box, including one made outside MiniBox.
- **REST and CLI only.** Listing and closing are `GET /api/boxes/:id/sessions`, `DELETE /api/boxes/:id/sessions/:name`, `minibox session ls` and `minibox session close`. A stopped box lists no sessions.
- **Errors.** `not_found` (404) means the session does not exist, or the box is stopped, and the hint says how to start it. `conflict` (409) with a hint means the box has no tmux, or, for a Bearer terminal, a tmux older than 3.2. Boxes from the base template include a tmux new enough for both. `taken_over` (409, `retryable: true`) means a person holds the session. `too_many_requests` (429) means a limit in this section was reached.
