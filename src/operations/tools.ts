import { dirname } from "node:path";

import { z } from "zod";

import { type LabelKey, msg } from "../lib/messages";
import { type Checked, accept, checkName, NAME_RE, reject } from "../lib/validation";
import { getBox } from "../services/boxes";
import { installTool, listToolStatuses, reconcileTools, uninstallTool, upgradeTool } from "../services/tools";
import { loadCatalog, TOOL_ID_RE } from "../tools/catalog";
import { TOOL_VERSION_RE } from "../tools/commands";
import { type CustomEntry, deleteCustomEntry, listCustomEntries, saveCustomEntry } from "../tools/custom";
import { type CatalogEntry, isToolCategory, TOOL_CATEGORIES, type ToolCategory } from "../tools/types";
import { assertCanAdministerCatalog } from "./authz";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import type { OperationContext } from "./types";
import { boxId, field } from "./validation";

const ToolStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(TOOL_CATEGORIES).meta({ description: "UI group: agents, languages, terminal or networking." }),
  source: z.enum(["npm", "pip", "script"]),
  package: z.string(),
  bin: z.string(),
  estimatedMb: z.number().int(),
  requires: z.string().nullable(),
  needsRoot: z.boolean().meta({
    description:
      "True when the install needs root, which MiniBox never runs. Install, upgrade and uninstall are refused.",
  }),
  desiredVersion: z.string().nullable(),
  installed: z.boolean().meta({
    description:
      "True when the detect command succeeds inside the box, whether MiniBox, the image or the home volume put the tool there.",
  }),
  installedVersion: z.string().nullable(),
  managed: z.boolean().meta({
    description:
      "True when the entry point is on the shared tools volume. Only then may upgrade or uninstall change it.",
  }),
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
  z.string().trim().min(1).max(64).regex(TOOL_VERSION_RE, "tool version").default("latest").meta({
    description:
      "Desired package version, or latest. Letters, digits, dots, underscores, plus and hyphen only (optional leading v).",
  });

export const toolList = defineOperation({
  name: "tool.list",
  tag: "tools",
  summary: "List tool catalog and install status",
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
      "List the tool catalog with installed status and version. Installed is detected in the box's own image and home volume, so tools baked into the image are reported too. Pass id to include the desired tools from that box's spec.",
  },
  run: async ({ host }, input) => ({ tools: await listToolStatuses(host, input.id) }),
});

export const toolInstall = defineOperation({
  name: "tool.install",
  tag: "tools",
  summary: "Install a tool into the shared tools volume",
  kind: "write",
  scope: "tool:install",
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
      "Install a tool from the catalog into the shared tools volume for a box. Updates BoxSpec.tools. Long-running; returns a task id.",
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
  summary: "Upgrade a tool on the shared tools volume",
  kind: "write",
  scope: "tool:install",
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
    description: "Upgrade a tool already recorded on a box. Returns a task id.",
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
  summary: "Uninstall a tool from the shared tools volume",
  kind: "destructive",
  scope: "tool:install",
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
    description: "Remove a tool from the shared tools volume and from the box spec. Returns a task id.",
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
  summary: "Install missing tools from the box spec",
  kind: "write",
  scope: "tool:install",
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
    category: entry.category,
    estimatedMb: entry.estimatedMb,
    requires: entry.requires ?? null,
    source: entry.source,
    needsRoot: entry.needsRoot,
  }));
}

export const toolCatalog = defineOperation({
  name: "tool.catalog",
  tag: "tools",
  summary: "List the tool catalog without install status",
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
        category: z.enum(TOOL_CATEGORIES),
        estimatedMb: z.number().int(),
        requires: z.string().nullable(),
        source: z.enum(["npm", "pip", "script"]),
        needsRoot: z.boolean(),
      }),
    ),
  }),
  rest: [{ method: "GET", path: "/api/tools/catalog" }],
  run: async ({ host }) => ({ tools: catalogSummary(dirname(host.specs.dir())) }),
});

const CUSTOM_LIMITS = { name: 80, description: 300, requires: 120, package: 214, command: 2000, estimatedMb: 102_400 };
const PACKAGE_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/+-]*$/;
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const PLACEHOLDERS: readonly string[] = ["prefix", "version", "package", "package_spec", "bin"];

/** Control characters, C1 included. `allowed` lists the ones a field may still hold. */
function hasControlCharacter(value: string, allowed: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || (code >= 0x7f && code < 0xa0)) && !allowed.includes(char)) return true;
  }
  return false;
}

function checkCustomId(value: unknown): Checked<string> {
  const id = typeof value === "string" ? value.trim() : "";
  return TOOL_ID_RE.test(id) ? accept(id) : reject(msg("tool_id_invalid"), "id");
}

function checkLine(value: unknown, key: string, label: LabelKey, max: number): Checked<string> {
  if (typeof value !== "string" || !value.trim()) return reject(msg("field_required", { label }), key);
  const text = value.trim();
  if ([...text].length > max || hasControlCharacter(text, "")) {
    return reject(msg("tool_custom_text_invalid", { label, max }), key);
  }
  return accept(text);
}

function checkOptionalLine(value: unknown, key: string, label: LabelKey, max: number): Checked<string | undefined> {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return accept(undefined);
  const checked = checkLine(value, key, label, max);
  return checked.ok ? accept(checked.value) : checked;
}

/** A command is `sh -c` text, so line breaks and tabs are real content. Every other control character is refused. */
function checkCommand(value: unknown, key: string, label: LabelKey): Checked<string> {
  if (typeof value !== "string" || !value.trim()) return reject(msg("field_required", { label }), key);
  const text = value.trim();
  if ([...text].length > CUSTOM_LIMITS.command || hasControlCharacter(text, "\n\t")) {
    return reject(msg("tool_custom_command_invalid", { label, max: CUSTOM_LIMITS.command }), key);
  }
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] ?? "";
    if (!PLACEHOLDERS.includes(name)) {
      return reject(msg("tool_custom_placeholder_invalid", { label, placeholder: `{{${name}}}` }), key);
    }
  }
  return accept(text);
}

/** The package is spliced unquoted into the install command, so only characters that are inert in `sh` pass. */
function checkPackage(value: unknown): Checked<string> {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return reject(msg("field_required", { label: "toolPackage" }), "package");
  return text.length <= CUSTOM_LIMITS.package && PACKAGE_RE.test(text)
    ? accept(text)
    : reject(msg("tool_custom_package_invalid", { label: "toolPackage" }), "package");
}

function checkBin(value: unknown): Checked<string> {
  const checked = checkName(value, "toolBin");
  return checked.ok ? checked : reject(checked.failure.message, "bin");
}

function checkCategory(value: unknown): Checked<ToolCategory> {
  return typeof value === "string" && isToolCategory(value)
    ? accept(value)
    : reject(msg("tool_category_invalid"), "category");
}

function checkSource(value: unknown): Checked<CatalogEntry["source"]> {
  return value === "npm" || value === "pip" || value === "script"
    ? accept(value)
    : reject(msg("tool_source_invalid"), "source");
}

function checkEstimatedMb(value: unknown): Checked<number> {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= CUSTOM_LIMITS.estimatedMb
    ? accept(n)
    : reject(msg("tool_estimated_invalid", { max: CUSTOM_LIMITS.estimatedMb }), "estimatedMb");
}

function checkFlag(value: unknown, key: string): Checked<boolean> {
  return typeof value === "boolean" ? accept(value) : reject(msg("not_boolean", { field: key }), key);
}

const customId = () =>
  field(checkCustomId, {
    type: "string",
    maxLength: 63,
    pattern: TOOL_ID_RE.source,
    description:
      "Entry id: a lowercase letter, then lowercase letters, digits or hyphens, at most 63 characters. It is the file name, tools.d/<id>.json.",
  });

const COMMAND_HELP =
  "Shell command run with sh -c in a helper on the tools volume. Placeholders: {{prefix}} (/opt/minibox/tools), {{version}}, {{package}}, {{package_spec}} (package plus the pin) and {{bin}}. Line breaks are allowed. At most 2000 characters.";

const customInput = z.object({
  id: customId(),
  name: field((value) => checkLine(value, "name", "toolName", CUSTOM_LIMITS.name), {
    type: "string",
    maxLength: CUSTOM_LIMITS.name,
    description: `Display name, one line, at most ${CUSTOM_LIMITS.name} characters.`,
  }),
  description: field((value) => checkLine(value, "description", "toolDescription", CUSTOM_LIMITS.description), {
    type: "string",
    maxLength: CUSTOM_LIMITS.description,
    description: `Short description, one line, at most ${CUSTOM_LIMITS.description} characters.`,
  }),
  category: field(checkCategory, {
    type: "string",
    enum: [...TOOL_CATEGORIES],
    description: "UI group: agents, languages, terminal or networking. Defaults to agents.",
  }).default("agents"),
  source: field(checkSource, {
    type: "string",
    enum: ["npm", "pip", "script"],
    description: "Where the package comes from. A script takes no version pin, so only latest installs.",
  }),
  package: field(checkPackage, {
    type: "string",
    maxLength: CUSTOM_LIMITS.package,
    description:
      "npm or pip package name, or a short label for a script. Letters, digits, @, dots, underscores, slashes, plus and hyphen.",
  }),
  bin: field(checkBin, {
    type: "string",
    maxLength: 63,
    pattern: NAME_RE.source,
    description: "Command name the install puts on the tools volume's bin directory.",
  }),
  needsRoot: field((value) => checkFlag(value, "needsRoot"), {
    type: "boolean",
    description:
      "True when the install needs root. MiniBox never runs root, so the entry is listed and every write is refused. Defaults to false.",
  }).default(false),
  estimatedMb: field(checkEstimatedMb, {
    type: "integer",
    minimum: 1,
    maximum: CUSTOM_LIMITS.estimatedMb,
    description: "Rough installed size in MB for the UI, from 1 to 102400. Defaults to 50.",
  }).default(50),
  requires: field((value) => checkOptionalLine(value, "requires", "toolRequires", CUSTOM_LIMITS.requires), {
    type: "string",
    maxLength: CUSTOM_LIMITS.requires,
    description: "Dependency note shown under the entry, such as Node ≥ 20. At most 120 characters.",
  }).optional(),
  install: field((value) => checkCommand(value, "install", "toolInstall"), {
    type: "string",
    maxLength: CUSTOM_LIMITS.command,
    description: `Install. ${COMMAND_HELP}`,
  }),
  upgrade: field((value) => checkCommand(value, "upgrade", "toolUpgrade"), {
    type: "string",
    maxLength: CUSTOM_LIMITS.command,
    description: `Upgrade. ${COMMAND_HELP}`,
  }),
  uninstall: field((value) => checkCommand(value, "uninstall", "toolUninstall"), {
    type: "string",
    maxLength: CUSTOM_LIMITS.command,
    description: `Uninstall. ${COMMAND_HELP}`,
  }),
  detect: field((value) => checkCommand(value, "detect", "toolDetect"), {
    type: "string",
    maxLength: CUSTOM_LIMITS.command,
    description:
      "Prints one line with the version (or nothing) and exits 0 when the tool is present. It runs in each box's image. Placeholders as for install.",
  }),
  overrideBuiltin: field((value) => checkFlag(value, "overrideBuiltin"), {
    type: "boolean",
    description:
      "Required to replace a built-in id, because the built-in entry would stop being used. Ignored for any other id. Defaults to false.",
  }).default(false),
});

const CustomToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(TOOL_CATEGORIES),
  source: z.enum(["npm", "pip", "script"]),
  package: z.string(),
  bin: z.string(),
  needsRoot: z.boolean(),
  estimatedMb: z.number().int(),
  requires: z.string().nullable(),
  install: z.string(),
  upgrade: z.string(),
  uninstall: z.string(),
  detect: z.string(),
  overridesBuiltin: z.boolean().meta({
    description: "True when the id is a built-in tool and this entry replaces its catalog entry.",
  }),
});

const dataDirOf = (ctx: OperationContext) => dirname(ctx.host.specs.dir());

function customOutput(entry: CustomEntry) {
  return { ...entry, requires: entry.requires ?? null };
}

export const toolCustomList = defineOperation({
  name: "tool.custom.list",
  tag: "tools",
  summary: "List the custom Agent CLI entries in DATA_DIR/tools.d",
  kind: "read",
  scope: "tool:custom",
  async: false,
  input: z.object({}),
  output: z.object({ tools: z.array(CustomToolSchema) }),
  rest: [{ method: "GET", path: "/api/tools/custom" }],
  cli: "tool custom list",
  mcp: {
    toolset: "tools",
    name: "list_custom_tools",
    description:
      "List the custom Agent CLI entries in DATA_DIR/tools.d, with their commands. overridesBuiltin marks an entry that replaces a built-in id. Owner only.",
  },
  run: async (ctx) => {
    await assertCanAdministerCatalog(ctx);
    return { tools: listCustomEntries(dataDirOf(ctx)).map(customOutput) };
  },
});

export const toolCustomPut = defineOperation({
  name: "tool.custom.put",
  tag: "tools",
  summary: "Create or replace a custom Agent CLI entry in DATA_DIR/tools.d",
  kind: "write",
  scope: "tool:custom",
  async: false,
  conflicts: true,
  input: customInput,
  output: z.object({ tool: CustomToolSchema }),
  rest: [{ method: "PUT", path: "/api/tools/custom/:id", body: true }],
  cli: "tool custom put",
  mcp: {
    toolset: "tools",
    name: "put_custom_tool",
    description:
      "Create or replace a custom Agent CLI entry, saved as DATA_DIR/tools.d/<id>.json. It takes effect for every later install, upgrade and detect. A built-in id needs overrideBuiltin true. Owner only.",
  },
  activity: { action: () => "tool.custom.put", target: (input) => input.id },
  audit: {
    target: (input) => ({ kind: "tool", name: input.id }),
    detail: (input) => ({
      id: input.id,
      category: input.category,
      source: input.source,
      package: input.package,
      bin: input.bin,
      needsRoot: input.needsRoot,
      overrideBuiltin: input.overrideBuiltin,
    }),
  },
  run: async (ctx, input) => {
    await assertCanAdministerCatalog(ctx);
    const { overrideBuiltin, ...entry } = input;
    return { tool: customOutput(saveCustomEntry(dataDirOf(ctx), entry, { overrideBuiltin })) };
  },
});

export const toolCustomDelete = defineOperation({
  name: "tool.custom.delete",
  tag: "tools",
  summary: "Delete a custom Agent CLI entry from tools.d. Nothing is uninstalled from the shared tools volume.",
  kind: "destructive",
  scope: "tool:custom",
  async: false,
  conflicts: true,
  input: z.object({ id: customId() }),
  output: z.object({
    id: z.string(),
    restoredBuiltin: z.boolean().meta({
      description: "True when a built-in entry with this id is back in the catalog after the delete.",
    }),
  }),
  rest: [{ method: "DELETE", path: "/api/tools/custom/:id" }],
  cli: "tool custom delete",
  mcp: {
    toolset: "tools",
    name: "delete_custom_tool",
    description:
      "Delete the tools.d file of a custom Agent CLI entry. It does not uninstall the tool from the shared tools volume. A built-in id with no tools.d file cannot be deleted. Owner only.",
  },
  activity: { action: () => "tool.custom.delete", target: (input) => input.id },
  audit: { target: (input) => ({ kind: "tool", name: input.id }) },
  run: async (ctx, input) => {
    await assertCanAdministerCatalog(ctx);
    return { id: input.id, ...deleteCustomEntry(dataDirOf(ctx), input.id) };
  },
});

export const toolOperations = [
  toolCatalog,
  toolList,
  toolInstall,
  toolUpgrade,
  toolUninstall,
  toolReconcile,
  toolCustomList,
  toolCustomPut,
  toolCustomDelete,
];
