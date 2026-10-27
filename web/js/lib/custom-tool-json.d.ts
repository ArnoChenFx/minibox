import type { CustomToolValues } from "./custom-tool.js";

/** Where a package comes from. */
export declare const TOOL_SOURCES: string[];

/** The field order of a catalog file: what a copy writes, and the order the dialog reads. */
export declare const TOOL_JSON_FIELDS: string[];

/** A catalog entry as the JSON description holds it, with the optional fields left out when they are unset. */
export interface ToolJsonEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  package: string;
  bin: string;
  needsRoot: boolean;
  estimatedMb: number;
  requires?: string;
  install: string;
  upgrade: string;
  uninstall: string;
  stop?: string;
  detect: string;
}

/** A tool as the box's tools panel lists it: a merged catalog entry plus the install status. */
export interface ToolStatusLike {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  package: string;
  bin: string;
  needsRoot: boolean;
  estimatedMb: number;
  requires?: string | null;
  install: string;
  upgrade: string;
  uninstall: string;
  stop?: string | null;
  detect: string;
}

/** A custom entry as `GET /api/tools/custom` reports it: the catalog fields, the flag, and null optionals. */
export interface CustomEntryStatusLike extends Omit<ToolStatusLike, "requires" | "stop"> {
  requires?: string | null;
  stop?: string | null;
  overridesBuiltin?: boolean;
}

/** The catalog entry a tool's row describes, as the JSON carries it. A custom entry for the id is used as it is. */
export declare function toolJsonEntry(
  tool: ToolStatusLike,
  customById?: ReadonlyMap<string, CustomEntryStatusLike>,
): ToolJsonEntry;

/** The JSON text a row copies: catalog field order, two spaces of indent, and the optional fields only when set. */
export declare function toolJsonText(entry: Partial<ToolJsonEntry>): string;

/** Why a pasted description was refused. */
export type ToolJsonError =
  | { code: "json"; detail: string }
  | { code: "unknownFields"; fields: string[] }
  | { code: "required"; field: string }
  | { code: "type"; field: string; expected: string }
  | { code: "tooLong"; field: string; max: number }
  | { code: "category"; value: string }
  | { code: "source"; value: string }
  | { code: "estimatedMb"; value: string }
  | { code: "id"; value: string };

export type ToolJsonParse = { ok: true; values: CustomToolValues } | { ok: false; error: ToolJsonError };

/** The form's values for a pasted JSON description, or the first problem that stops it. */
export declare function parseToolJson(text: string, options?: { taken?: ReadonlySet<string> }): ToolJsonParse;

/** The id a pasted entry takes: its own id when free, else `<id>-copy`, `-copy-2` and so on within 63 characters. */
export declare function copyId(id: string, taken?: ReadonlySet<string>): string;
