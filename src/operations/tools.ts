import { dirname } from "node:path";

import { z } from "zod";

import { getBox } from "../services/boxes";
import { installTool, listToolStatuses, reconcileTools, uninstallTool, upgradeTool } from "../services/tools";
import { loadCatalog } from "../tools/catalog";
import { TOOL_VERSION_RE } from "../tools/commands";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { boxId } from "./validation";

const ToolStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["npm", "pip", "script"]),
  package: z.string(),
  bin: z.string(),
  estimatedMb: z.number().int(),
  requires: z.string().nullable(),
  desiredVersion: z.string().nullable(),
  installed: z.boolean(),
  installedVersion: z.string().nullable(),
});

const toolId = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9-]*$/, "tool id")
    .meta({ description: "Catalog tool id, such as claude-code." });

const toolVersion = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(TOOL_VERSION_RE, "tool version")
    .default("latest")
    .meta({
      description:
        "Desired package version, or latest. Letters, digits, dots, underscores, plus and hyphen only (optional leading v).",
    });

export const toolList = defineOperation({
  name: "tool.list",
  tag: "tools",
  summary: "List Agent CLI catalog and install status",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({
    id: boxId().optional().meta({ description: "When set, desired versions come from this box's spec." }),
  }),
  output: z.object({ tools: z.array(ToolStatusSchema) }),
  rest: [{ method: "GET", path: "/api/tools", query: ["id"] }],
  cli: "tool list",
  mcp: {
    toolset: "tools",
    name: "list_tools",
    description:
      "List the Agent CLI catalog with installed status and version. Pass id to include the desired tools from that box's spec.",
  },
  run: async ({ host }, input) => ({ tools: await listToolStatuses(host, input.id) }),
});

export const toolInstall = defineOperation({
  name: "tool.install",
  tag: "tools",
  summary: "Install an Agent CLI into the shared tools volume",
  kind: "write",
  scope: "box:write",
  async: true,
  conflicts: true,
  input: z.object({ id: boxId(), tool: toolId(), version: toolVersion() }),
  output: z.object({
    id: z.string(),
    version: z.string(),
    installedVersion: z.string().nullable(),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/tools/install", body: true, status: 202 }],
  cli: "tool install",
  mcp: {
    toolset: "tools",
    name: "install_tool",
    description:
      "Install an Agent CLI from the catalog into the shared tools volume for a box. Updates BoxSpec.tools. Long-running; returns a task id.",
  },
  resolve: ({ host }, input) => getBox(host, input.id),
  exclusive: ({ host }) => `tool.write:${host.host.id}`,
  activity: { action: () => "tool.install", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task }, input) => installTool(host, input.id, input.tool, input.version, task),
});

export const toolUpgrade = defineOperation({
  name: "tool.upgrade",
  tag: "tools",
  summary: "Upgrade an Agent CLI on the shared tools volume",
  kind: "write",
  scope: "box:write",
  async: true,
  conflicts: true,
  input: z.object({ id: boxId(), tool: toolId(), version: toolVersion() }),
  output: z.object({
    id: z.string(),
    version: z.string(),
    installedVersion: z.string().nullable(),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/tools/upgrade", body: true, status: 202 }],
  cli: "tool upgrade",
  mcp: {
    toolset: "tools",
    name: "upgrade_tool",
    description: "Upgrade an Agent CLI already recorded on a box. Returns a task id.",
  },
  resolve: ({ host }, input) => getBox(host, input.id),
  exclusive: ({ host }) => `tool.write:${host.host.id}`,
  activity: { action: () => "tool.upgrade", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task }, input) => upgradeTool(host, input.id, input.tool, input.version, task),
});

export const toolUninstall = defineOperation({
  name: "tool.uninstall",
  tag: "tools",
  summary: "Uninstall an Agent CLI from the shared tools volume",
  kind: "destructive",
  scope: "box:write",
  async: true,
  conflicts: true,
  input: z.object({ id: boxId(), tool: toolId() }),
  output: z.object({
    id: z.string(),
    version: z.string(),
    installedVersion: z.string().nullable(),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/tools/uninstall", body: true, status: 202 }],
  cli: "tool uninstall",
  mcp: {
    toolset: "tools",
    name: "uninstall_tool",
    description: "Remove an Agent CLI from the shared tools volume and from the box spec. Returns a task id.",
  },
  resolve: ({ host }, input) => getBox(host, input.id),
  exclusive: ({ host }) => `tool.write:${host.host.id}`,
  activity: { action: () => "tool.uninstall", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task }, input) => uninstallTool(host, input.id, input.tool, task),
});

export const toolReconcile = defineOperation({
  name: "tool.reconcile",
  tag: "tools",
  summary: "Install missing Agent CLIs from the box spec",
  kind: "write",
  scope: "box:write",
  async: true,
  conflicts: true,
  input: z.object({ id: boxId() }),
  output: z.object({
    installed: z.array(z.string()),
    skipped: z.array(z.string()),
    failed: z.array(z.object({ id: z.string(), detail: z.string() })),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/tools/reconcile", status: 202 }],
  cli: "tool reconcile",
  mcp: {
    toolset: "tools",
    name: "reconcile_tools",
    description:
      "Idempotently install every tool listed on the box spec that is not detected on the shared tools volume. Used after create and rebuild.",
  },
  resolve: ({ host }, input) => getBox(host, input.id),
  exclusive: ({ host }) => `tool.write:${host.host.id}`,
  activity: { action: () => "tool.reconcile", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task }, input) => reconcileTools(host, input.id, task),
});

/** Catalog-only list used by the create dialog before a box exists. */
export function catalogSummary(dataDir: string) {
  return loadCatalog(dataDir).map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    estimatedMb: entry.estimatedMb,
    requires: entry.requires ?? null,
    source: entry.source,
  }));
}

export const toolCatalog = defineOperation({
  name: "tool.catalog",
  tag: "tools",
  summary: "List the Agent CLI catalog without install status",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({}),
  output: z.object({
    tools: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        estimatedMb: z.number().int(),
        requires: z.string().nullable(),
        source: z.enum(["npm", "pip", "script"]),
      }),
    ),
  }),
  rest: [{ method: "GET", path: "/api/tools/catalog" }],
  run: async ({ host }) => ({ tools: catalogSummary(dirname(host.specs.dir())) }),
});

export const toolOperations = [toolCatalog, toolList, toolInstall, toolUpgrade, toolUninstall, toolReconcile];
