/** One Agent CLI entry from `catalog/*.json` or `DATA_DIR/tools.d/*.json`. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Where the package comes from. */
  source: "npm" | "pip" | "script";
  /** Package name for npm/pip, or a short label for scripts. */
  package: string;
  /** Binary name on PATH after install (under `/opt/minibox/tools/bin`). */
  bin: string;
  /** Whether the install needs root inside the writer. Built-ins are false. */
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
  source: CatalogEntry["source"];
  package: string;
  bin: string;
  estimatedMb: number;
  requires: string | null;
  /** Desired version from the box spec, or null when the tool is only in the catalog. */
  desiredVersion: string | null;
  /** True when detect succeeded. */
  installed: boolean;
  /** Detected version string, or null when missing / undetectable. */
  installedVersion: string | null;
}

export const TOOLS_PREFIX = "/opt/minibox/tools";
export const TOOLS_BIN = `${TOOLS_PREFIX}/bin`;
