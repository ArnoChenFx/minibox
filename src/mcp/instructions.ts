/**
 * Pasteable instructions for an agent working through MiniBox. README.md and docs/agents.md include this text,
 * and the MCP `instructions` field does too, so the three stay the same.
 */
export const AGENTS_MD_SNIPPET = `## MiniBox

Use the MiniBox MCP server (\`/mcp\`, Bearer access key) to work inside a box.

- list_boxes or create_box before doing work. exec starts a stopped box.
- exec takes argv (no shell) or cmd (via /bin/sh -c). Default user is dev, default directory is /workspace.
- The result includes exitCode, stdout, stderr, truncated and durationMs. A non-zero exit code is the program's status.
- Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream. When truncated is true, outputRef names the rest: GET /api/execs/{execId}/output.
- Commands that may run longer than 30 seconds: exec with background true, then exec_get with waitMs (max 25000). exec_kill stops the process tree.
- exec can read and write every volume mounted on that box.
- File tools are not available yet. Ask for toolsets with /mcp?toolsets=core,session. The default is core and meta. The design catalog is 27 tools, 15 of them in the default toolsets; this server exposes the tools that are implemented.`;

/** What the MCP initialize result tells the client. Checkpoints and file tools are named so an agent does not invent them. */
export const MCP_INSTRUCTIONS = `Recommended flow: list_boxes or create_box, then exec. Checkpoints are not available yet. File tools are not available yet. The design catalog has 27 tools and the default toolsets are core and meta (15 tools). This server exposes the implemented tools in the requested toolsets.

${AGENTS_MD_SNIPPET}`;
