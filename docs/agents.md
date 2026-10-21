# Agents

`POST /mcp` is a Streamable HTTP MCP server. Send `Authorization: Bearer` and the access key. A browser session cookie is refused. `GET /mcp` is not an event stream (`405`, `Allow: POST, DELETE`). `DELETE /mcp` closes the session named by `Mcp-Session-Id`.

`?toolsets=` selects toolsets (`core`, `session`, `network`, `storage`, `tools`, `meta`). The query wins over the session. The default is `core,meta`. The design catalog is 27 tools, 15 of them in those two default toolsets. This server exposes the tools that exist: the seven box tools plus `exec`, `exec_get` and `exec_kill`. `get_activity` and `task_wait` are not implemented yet, so the live default list is 10 tools. The other toolsets are accepted and currently add none. File tools are not implemented.

`minibox mcp` proxies newline-delimited JSON-RPC from stdio to `/mcp`. Build the binary with `bun run build:cli`.

The `initialize` result includes the block below. [`README.md`](../README.md) includes the same text, so an agent can paste it into `AGENTS.md`.

## MiniBox

Use the MiniBox MCP server (`/mcp`, Bearer access key) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace.
- The result includes exitCode, stdout, stderr, truncated and durationMs. A non-zero exit code is the program's status.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When truncated is true, outputRef names the rest: GET /api/execs/{execId}/output.
- Commands that may run longer than 30 seconds: exec with background true, then exec_get with waitMs (max 25000). exec_kill stops the process tree.
- exec can read and write every volume mounted on that box.
- File tools are not available yet. Ask for toolsets with /mcp?toolsets=core,session. The default is core and meta. The design catalog is 27 tools, 15 of them in the default toolsets; this server exposes the tools that are implemented.

## Exec

`exec` means the caller can read and write every volume mounted on that box. Finer `files:*` scopes only matter for a token that does not have `exec`. Attaching a volume requires `volume:attach` (#13, not enforced yet).

A foreground call should finish within about 60 seconds, which is the server's idle timeout. Longer commands use `background: true` and `exec_get`. A timeout kills the process tree and returns `timedOut: true` with the exit code from `exec.inspect` (137 when the engine does not report one). Stopping a box is not required before `exec`: a stopped box is started. Idle timeout and TTL remain #12.

File read and write, including archive access and a helper container for a stopped box, are not in this server. They follow Volume (#24).
