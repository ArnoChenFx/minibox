/**
 * The JSON description of a tool entry: the text a tool's row copies, and what the custom-tool dialog reads back from a
 * pasted one. The shape is the one `catalog/*.json` and `DATA_DIR/tools.d/*.json` hold, so a copy can be pasted into the
 * dialog, saved as a `tools.d` file, or sent to `PUT /api/tools/custom/:id` as it is. Pure: the dialog and the tests
 * share it, and nothing here touches the DOM.
 *
 * The server validates the body again, so these checks only keep the form in step with it. A field the description does
 * not recognise is named in the message rather than silently dropped, because a typo in a command would otherwise only
 * show up when an install runs.
 */
import { COMMAND_FIELDS, CUSTOM_LIMITS, OPTIONAL_COMMANDS, validCustomId } from "./custom-tool.js";
import { TOOL_CATEGORY_ORDER } from "./tool-list.js";

/** Where a package comes from. Mirrors the server's list, and the order the dialog offers. */
export const TOOL_SOURCES = ["npm", "pip", "script"];

/** The field order of a catalog file: what a copy writes, and the order the dialog reads. */
export const TOOL_JSON_FIELDS = [
  "id",
  "name",
  "description",
  "category",
  "source",
  "package",
  "bin",
  "needsRoot",
  "estimatedMb",
  "requires",
  ...COMMAND_FIELDS,
];

/** The command fields every entry must set. `stop` may be left out or left blank, as the server allows. */
const REQUIRED_COMMANDS = COMMAND_FIELDS.filter((field) => !OPTIONAL_COMMANDS.includes(field));

/** The text fields, and how long the server takes each one. `requires` is optional, so it may be left out. */
const TEXT_LIMITS = {
  name: CUSTOM_LIMITS.name,
  description: CUSTOM_LIMITS.description,
  package: CUSTOM_LIMITS.package,
  bin: CUSTOM_LIMITS.bin,
  requires: CUSTOM_LIMITS.requires,
};

/**
 * The catalog entry a tool's row describes, as the JSON carries it. The box's tools list already reports the merged
 * catalog's entry, commands included, so a built-in tool and a custom one are described the same way.
 */
export function toolJsonEntry(tool) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    source: tool.source,
    package: tool.package,
    bin: tool.bin,
    needsRoot: tool.needsRoot === true,
    estimatedMb: tool.estimatedMb,
    requires: tool.requires ?? undefined,
    install: tool.install,
    upgrade: tool.upgrade,
    uninstall: tool.uninstall,
    stop: tool.stop ?? undefined,
    detect: tool.detect,
  };
}

/**
 * The JSON text a row copies: the catalog's own shape and field order, two spaces of indent, and `requires` and `stop`
 * only when the entry sets them, exactly as `saveCustomEntry` writes a `tools.d` file.
 */
export function toolJsonText(entry) {
  const out = {};
  for (const field of TOOL_JSON_FIELDS) {
    const value = entry[field];
    if (value === undefined || value === null) continue;
    if (OPTIONAL_COMMANDS.includes(field) && String(value).trim() === "") continue;
    if (field === "requires" && String(value).trim() === "") continue;
    out[field] = value;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON body's own number or text, as the form holds it. */
const sizeText = (value) => (typeof value === "number" || typeof value === "string" ? String(value) : "");

/**
 * What the dialog shows for one parsed entry: the form's values, or the first problem that stops it. The id is the one
 * that gets the copy suffix (see `copyId`), since a paste adds a tool rather than replacing the one it came from.
 * Nothing is thrown, so the caller can keep whatever is already typed.
 */
export function parseToolJson(text, { taken = new Set() } = {}) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ""));
  } catch (e) {
    return { ok: false, error: { code: "json", detail: e instanceof Error ? e.message : String(e) } };
  }
  if (!isObject(raw)) return { ok: false, error: { code: "json", detail: "the root is not an object" } };

  const unknown = Object.keys(raw).filter((key) => !TOOL_JSON_FIELDS.includes(key));
  if (unknown.length) return { ok: false, error: { code: "unknownFields", fields: unknown } };

  for (const field of ["id", "name", "description", "package", "bin", ...REQUIRED_COMMANDS]) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) {
      return { ok: false, error: { code: "required", field } };
    }
  }
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return { ok: false, error: { code: "type", field, expected: "string" } };
    if ([...value].length > max) return { ok: false, error: { code: "tooLong", field, max } };
  }
  for (const field of COMMAND_FIELDS) {
    if (typeof raw[field] !== "string") {
      if (OPTIONAL_COMMANDS.includes(field) && raw[field] === undefined) continue;
      return { ok: false, error: { code: "required", field } };
    }
    if (!raw[field].trim() && !OPTIONAL_COMMANDS.includes(field)) {
      return { ok: false, error: { code: "required", field } };
    }
    if ([...raw[field]].length > CUSTOM_LIMITS.command) {
      return { ok: false, error: { code: "tooLong", field, max: CUSTOM_LIMITS.command } };
    }
  }
  if (raw.category !== undefined && !TOOL_CATEGORY_ORDER.includes(raw.category)) {
    return { ok: false, error: { code: "category", value: String(raw.category) } };
  }
  if (raw.source !== undefined && !TOOL_SOURCES.includes(raw.source)) {
    return { ok: false, error: { code: "source", value: String(raw.source) } };
  }
  if (raw.needsRoot !== undefined && typeof raw.needsRoot !== "boolean") {
    return { ok: false, error: { code: "type", field: "needsRoot", expected: "boolean" } };
  }
  const size = sizeText(raw.estimatedMb).trim();
  if (raw.estimatedMb !== undefined && !/^\d+$/.test(size)) {
    return { ok: false, error: { code: "estimatedMb", value: size } };
  }

  const id = raw.id.trim();
  if (!validCustomId(id)) return { ok: false, error: { code: "id", value: id } };

  const values = {
    id: copyId(id, taken),
    name: raw.name.trim(),
    description: raw.description.trim(),
    category: raw.category ?? "agents",
    source: raw.source ?? "npm",
    package: raw.package.trim(),
    bin: raw.bin.trim(),
    requires: typeof raw.requires === "string" ? raw.requires.trim() : "",
    estimatedMb: size || "50",
    needsRoot: raw.needsRoot === true,
    overrideBuiltin: false,
    install: raw.install.trim(),
    upgrade: raw.upgrade.trim(),
    uninstall: raw.uninstall.trim(),
    stop: typeof raw.stop === "string" ? raw.stop.trim() : "",
    detect: raw.detect.trim(),
  };
  return { ok: true, values };
}

/**
 * The id a pasted entry takes: the id it names, unless that id is taken (`taken` holds the built-in ids and the saved
 * custom ones). A taken id becomes `<id>-copy`, then `-copy-2`, `-copy-3` and so on, cut from the stem first so the name
 * stays inside `CUSTOM_LIMITS.id`. An id that is not a valid one is kept as it is, so the dialog can say so.
 */
export function copyId(id, taken = new Set()) {
  const stem = String(id ?? "").trim();
  if (!validCustomId(stem)) return stem;
  if (!taken.has(stem)) return stem;
  const withTail = (tail) => {
    const cut = stem.slice(0, CUSTOM_LIMITS.id - tail.length).replace(/-+$/, "");
    return `${cut || "tool"}${tail}`;
  };
  const first = withTail("-copy");
  if (!taken.has(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = withTail(`-copy-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return first;
}
