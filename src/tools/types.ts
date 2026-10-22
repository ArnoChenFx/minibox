/** UI groups for the catalog. The ids are stable; the labels live in the web i18n files. */
export const TOOL_CATEGORIES = ["agents", "languages", "terminal", "networking"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export function isToolCategory(value: string): value is ToolCategory {
  return (TOOL_CATEGORIES as readonly string[]).includes(value);
}

/** One tool entry from `catalog/*.json` or `DATA_DIR/tools.d/*.json`. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  /** Where the package comes from. */
  source: "npm" | "pip" | "script";
  /** Package name for npm/pip, or a short label for scripts. */
  package: string;
  /** Binary name on PATH after install (under `/opt/minibox/tools/bin`). */
  bin: string;
  /**
   * The install needs root, which MiniBox never runs. Such entries are listed so the UI can say why they are not
   * installable, and every write is refused with `tool_needs_root`.
   */
  needsRoot: boolean;
  /** Rough installed size for the UI. */
  estimatedMb: number;
  /** Human-readable dependency note, such as `Node ≥ 20`. */
  requires?: string;
  /**
   * Shell fragments run with `sh -c` in the tools writer.
   * Placeholders: `{{prefix}}` `/opt/minibox/tools`, `{{version}}`, `{{package}}`, `{{bin}}`.
   */
  install: string;
  upgrade: string;
  uninstall: string;
  /** Prints a single-line version (or empty) to stdout. Exit 0 when present. */
  detect: string;
}

export type ToolAction = "install" | "upgrade" | "uninstall";

export interface ToolStatus {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  source: CatalogEntry["source"];
  package: string;
  bin: string;
  estimatedMb: number;
  requires: string | null;
  needsRoot: boolean;
  /** Desired version from the box spec, or null when the tool is only in the catalog. */
  desiredVersion: string | null;
  /** True when the detect command succeeded in the box, whether MiniBox, the image or the home volume put it there. */
  installed: boolean;
  /** Detected version string, or null when missing or the tool prints none. */
  installedVersion: string | null;
  /**
   * True when the entry point sits on the shared tools volume. Only then may MiniBox upgrade or uninstall the tool;
   * a copy baked into the image or the home volume is shown as installed and left alone.
   */
  managed: boolean;
}

export const TOOLS_PREFIX = "/opt/minibox/tools";
export const TOOLS_BIN = `${TOOLS_PREFIX}/bin`;
