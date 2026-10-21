import { type JsonSchema, toJsonSchema } from "./jsonschema";
import type { Kind, Operation, Toolset } from "./types";

/** The toolsets served when a client does not ask for others: `/mcp?toolsets=core,storage` opens more. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ["core", "meta"];

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly toolset: Toolset;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean };
}

/** The MCP tools of the operations in the given toolsets, in registry order. */
export function mcpTools(operations: readonly Operation[], toolsets: readonly Toolset[] = DEFAULT_TOOLSETS): McpTool[] {
  return operations.flatMap((op) => {
    if (!op.mcp || !toolsets.includes(op.mcp.toolset)) return [];
    return [
      {
        name: op.mcp.name,
        description: op.mcp.description,
        toolset: op.mcp.toolset,
        inputSchema: toJsonSchema(op.input),
        outputSchema: toJsonSchema(op.output, "output"),
        annotations: { readOnlyHint: op.kind === "read", destructiveHint: op.kind === "destructive" },
      },
    ];
  });
}

export interface CliCommand {
  readonly command: string;
  readonly operation: string;
  readonly summary: string;
  readonly kind: Kind;
}

/** The CLI commands the operations name, in registry order. `src/cli.ts` is the client; `bun run build:cli` compiles it. */
export function cliCommands(operations: readonly Operation[]): CliCommand[] {
  return operations.flatMap((op) =>
    op.cli ? [{ command: op.cli, operation: op.name, summary: op.summary, kind: op.kind }] : [],
  );
}
