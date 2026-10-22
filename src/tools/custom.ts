import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DIR_MODE, writeFileAtomic } from "../data-dir";
import { conflict, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { BUNDLED_CATALOG_DIR, parseCatalogEntry, readDirEntries } from "./catalog";
import type { CatalogEntry } from "./types";

/** Mode of a saved entry. DATA_DIR is 0700, so the directory is what keeps other users out. */
export const CUSTOM_FILE_MODE = 0o644;

/** A custom entry as the API reports it: the loader's view of the file, and whether it replaces a built-in id. */
export interface CustomEntry extends CatalogEntry {
  readonly overridesBuiltin: boolean;
}

export interface SaveOptions {
  /** Required to replace a built-in id. Ignored for any other id. */
  readonly overrideBuiltin: boolean;
  readonly bundledDir?: string;
}

export function customDir(dataDir: string): string {
  return join(dataDir, "tools.d");
}

function builtinIds(bundledDir: string): Set<string> {
  return new Set(readDirEntries(bundledDir).map((entry) => entry.id));
}

/** The entries the loader merges from tools.d. A later file with the same id wins, as it does in the loader. */
export function listCustomEntries(dataDir: string, bundledDir = BUNDLED_CATALOG_DIR): CustomEntry[] {
  const builtin = builtinIds(bundledDir);
  const byId = new Map<string, CatalogEntry>();
  for (const entry of readDirEntries(customDir(dataDir))) byId.set(entry.id, entry);
  return [...byId.values()]
    .map((entry) => ({ ...entry, overridesBuiltin: builtin.has(entry.id) }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

interface CustomFile {
  readonly name: string;
  /** The id the file's JSON names, or undefined when the file does not parse to an object with a string id. */
  readonly id: string | undefined;
}

function idNamedBy(path: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id.trim() : undefined;
}

/**
 * Every `.json` file in tools.d with the id it names. Unlike the loader this never throws, so a broken file can still
 * be found and deleted by its name.
 */
function customFiles(dataDir: string): CustomFile[] {
  const dir = customDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => ({ name, id: idNamedBy(join(dir, name)) }));
}

/**
 * Writes `tools.d/<id>.json`. The text is checked with the loader's own parser before it is written, so a file that
 * the loader would reject is never written. Another file that defines the same id, or a file named `<id>.json` that
 * defines a different id, is a conflict: the save refuses rather than drop a definition someone wrote by hand.
 */
export function saveCustomEntry(dataDir: string, entry: CatalogEntry, opts: SaveOptions): CustomEntry {
  const builtin = builtinIds(opts.bundledDir ?? BUNDLED_CATALOG_DIR).has(entry.id);
  if (builtin && !opts.overrideBuiltin) throw conflict(msg("tool_custom_builtin", { id: entry.id }));

  const dir = customDir(dataDir);
  const name = `${entry.id}.json`;
  for (const file of customFiles(dataDir)) {
    if (file.name === name && file.id !== undefined && file.id !== entry.id) {
      throw conflict(msg("tool_custom_file_other", { file: name, other: file.id, id: entry.id }));
    }
    if (file.name !== name && file.id === entry.id) {
      throw conflict(msg("tool_custom_file_conflict", { file: file.name, id: entry.id }));
    }
  }

  const text = `${JSON.stringify(toFile(entry), null, 2)}\n`;
  const stored = parseCatalogEntry(JSON.parse(text), join(dir, name));
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  writeFileAtomic(join(dir, name), text, CUSTOM_FILE_MODE);
  return { ...stored, overridesBuiltin: builtin };
}

/**
 * Removes the tools.d files that define `id`, and nothing else. A tool already installed on the shared tools volume
 * stays installed. A built-in id with no tools.d file has nothing to remove, so it is refused.
 */
export function deleteCustomEntry(
  dataDir: string,
  id: string,
  bundledDir = BUNDLED_CATALOG_DIR,
): { restoredBuiltin: boolean } {
  const builtin = builtinIds(bundledDir).has(id);
  const name = `${id}.json`;
  const targets = customFiles(dataDir).filter(
    (file) => file.id === id || (file.name === name && file.id === undefined),
  );
  if (targets.length === 0) {
    if (builtin) throw conflict(msg("tool_custom_builtin_delete", { id }));
    throw notFound(msg("tool_custom_not_found", { id }));
  }
  for (const file of targets) rmSync(join(customDir(dataDir), file.name), { force: true });
  return { restoredBuiltin: builtin };
}

/** The JSON the loader reads back: fixed field order, and `requires` only when it is set. */
function toFile(entry: CatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    source: entry.source,
    package: entry.package,
    bin: entry.bin,
    needsRoot: entry.needsRoot,
    estimatedMb: entry.estimatedMb,
    ...(entry.requires === undefined ? {} : { requires: entry.requires }),
    install: entry.install,
    upgrade: entry.upgrade,
    uninstall: entry.uninstall,
    detect: entry.detect,
  };
}
