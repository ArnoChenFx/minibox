/**
 * Pasteable instructions for an agent working through MiniBox. README.md and docs/agents.md include this text,
 * and the MCP `instructions` field does too, so the three stay the same.
 */
export const AGENTS_MD_SNIPPET = `## MiniBox

Use the MiniBox MCP server (\`/mcp\`, Bearer access key or agent token) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box, which changes its revision, unless the box's TTL has passed: then exec fails with box_ttl_expired. Read the revision again before an update that sends expectedRevision.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace. A strict box allows only dev or 1000 as the user. The box needs /bin/sh, cat, rm and sleep.
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
- The tools toolset (\`/mcp?toolsets=tools\`) holds list_tools, install_tool, upgrade_tool, uninstall_tool and reconcile_tools. Installs write to the shared tools volume and update BoxSpec.tools. list_custom_tools, put_custom_tool and delete_custom_tool manage the custom catalog in DATA_DIR/tools.d. Only the owner may use them. delete_custom_tool removes the file and does not uninstall the tool.
- The storage toolset (\`/mcp?toolsets=storage\`) holds the volume and pool tools. create_volume, delete_volume, attach_volume, detach_volume and replace_pools need confirm true. Without it the call changes nothing and returns confirmation_required with details.preview. attach_volume and detach_volume rebuild the box, so the same mount rules apply as to rebuild_box. measure_volume only refreshes the cached size.
- The network toolset (\`/mcp?toolsets=network\`) holds list_ports and expose_port for path-mode previews under \`/box/<name>/<port>/\`.
- read_file, write_file, list_files and copy_files act on volumes (not boxes). They work when no box is running, via a helper container and the Docker archive API. A call keeps the boxes that mount the volume awake while it runs, and it never starts a stopped box. Paths are jailed inside the volume. write_file stamps uid/gid 1000 (dev). exec already implies volume RW on mounts of boxes the token may use; files:* only matters without exec.
- The default toolsets are core and meta. The design catalog is 27 tools, 15 of them in the default toolsets; this server exposes the tools that are implemented.`;

/** What the MCP initialize result tells the client. Checkpoints are named so an agent does not invent them. */
export const MCP_INSTRUCTIONS = `Recommended flow: list_boxes or create_box, then exec and the file tools (read_file / write_file / list_files / copy_files) on volumes. Checkpoints are not available yet. The design catalog has 27 tools and the default toolsets are core and meta (15 tools). This server exposes the implemented tools in the requested toolsets. rebuild_box is in the rebuild toolset. The session toolset holds session_start, session_send and session_read. The volume and pool tools are in the storage toolset. The tools toolset holds Agent CLI install operations and the owner's custom catalog operations. The network toolset holds list_ports and expose_port for path-mode previews.

${AGENTS_MD_SNIPPET}`;
