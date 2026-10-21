/**
 * Pasteable instructions for an agent working through MiniBox. README.md and docs/agents.md include this text,
 * and the MCP `instructions` field does too, so the three stay the same.
 */
export const AGENTS_MD_SNIPPET = `## MiniBox

Use the MiniBox MCP server (\`/mcp\`, Bearer access key) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box, which changes its revision. Read the revision again before an update that sends expectedRevision.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace. A strict box allows only dev or 1000 as the user. The box needs /bin/sh, cat and rm.
- Pass secrets in env, not in argv or cmd. The audit log keeps commands and argv, but never env values.
- The result includes status, exitCode, stdout, stderr, truncated and durationMs. A non-zero exit code is the program's status.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When truncated is true, outputRef names the rest: GET /api/execs/{execId}/output.
- A foreground exec may set timeoutSec up to 55. For a longer command, use exec with background true and a larger timeoutSec (up to 3600), then exec_get with waitMs (max 25000). exec_kill stops the process tree.
- exec can read and write every volume mounted on that box.
- rebuild_box is in the rebuild toolset (\`/mcp?toolsets=rebuild\`) and needs confirm true.
- session_start, session_send and session_read drive a tmux session in the box. They are in the session toolset (\`/mcp?toolsets=core,session\`). A session keeps running after you disconnect. Use exec for one-off commands and a session for long-running or interactive programs. Listing and closing sessions are in the REST API and the CLI only.
- A session started through MCP has origin agent. A person can take it over in the console. While they hold it, session_send fails with taken_over and retryable true: wait a little, read the session with session_read, and send again. session_read still works during a takeover.
- session_read returns lines and a cursor. Pass the newest cursor as since to read only what is new. reset true means the screen was redrawn, and lines is the current window.
- session_send takes keys (tmux names such as Enter, Tab, Escape or C-c) or text, but not both. The audit log keeps the counts, never the input.
- File tools are not available yet. The default toolsets are core and meta. The design catalog is 27 tools, 15 of them in the default toolsets; this server exposes the tools that are implemented.`;

/** What the MCP initialize result tells the client. Checkpoints and file tools are named so an agent does not invent them. */
export const MCP_INSTRUCTIONS = `Recommended flow: list_boxes or create_box, then exec. Checkpoints are not available yet. File tools are not available yet. The design catalog has 27 tools and the default toolsets are core and meta (15 tools). This server exposes the implemented tools in the requested toolsets. rebuild_box is in the rebuild toolset. The session toolset holds session_start, session_send and session_read.

${AGENTS_MD_SNIPPET}`;
