import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../config";
import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { isToolCategory, TOOL_CATEGORIES, type CatalogEntry } from "./types";

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const SOURCES = new Set(["npm", "pip", "script"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, file: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(msg("tool_catalog_invalid", { file, detail: `missing string field ${key}` }));
  }
  return value.trim();
}

/** Parses one catalog JSON document. Throws AppError on a bad entry. */
export function parseCatalogEntry(raw: unknown, file: string): CatalogEntry {
  if (!isObject(raw)) throw badRequest(msg("tool_catalog_invalid", { file, detail: "root must be an object" }));
  const id = requireString(raw, "id", file);
  if (!ID.test(id)) throw badRequest(msg("tool_catalog_invalid", { file, detail: `invalid id ${id}` }));
  // Custom tools.d entries written before categories existed have no category; they were Agent CLIs, so they join
  // the agents group instead of breaking the whole catalog.
  const category = raw.category === undefined ? "agents" : requireString(raw, "category", file);
  if (!isToolCategory(category)) {
    throw badRequest(
      msg("tool_catalog_invalid", {
        file,
        detail: `unknown category ${category} (expected ${TOOL_CATEGORIES.join(", ")})`,
      }),
    );
  }
  const source = requireString(raw, "source", file);
  if (!SOURCES.has(source)) {
    throw badRequest(msg("tool_catalog_invalid", { file, detail: `unknown source ${source}` }));
  }
  const needsRoot = raw.needsRoot === true;
  const estimatedMb = typeof raw.estimatedMb === "number" && raw.estimatedMb > 0 ? Math.floor(raw.estimatedMb) : 50;
  const requires = typeof raw.requires === "string" && raw.requires.trim() ? raw.requires.trim() : undefined;
  return {
    id,
    name: requireString(raw, "name", file),
    description: requireString(raw, "description", file),
    category,
    source: source as CatalogEntry["source"],
    package: requireString(raw, "package", file),
    bin: requireString(raw, "bin", file),
    needsRoot,
    estimatedMb,
    requires,
    install: requireString(raw, "install", file),
    upgrade: requireString(raw, "upgrade", file),
    uninstall: requireString(raw, "uninstall", file),
    detect: requireString(raw, "detect", file),
  };
}

function readDirEntries(dir: string): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  const out: CatalogEntry[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw badRequest(msg("tool_catalog_invalid", { file: path, detail: e instanceof Error ? e.message : String(e) }));
    }
    out.push(parseCatalogEntry(raw, path));
  }
  return out;
}

/**
 * Built-in entries from the repo `catalog/` directory, overridden by `DATA_DIR/tools.d/*.json` with the same id.
 * Custom ids are appended. The first load failure for a custom file is a 400 so operators see the bad file.
 */
export function loadCatalog(dataDir: string, bundledDir = join(ROOT, "catalog")): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of readDirEntries(bundledDir)) byId.set(entry.id, entry);
  for (const entry of readDirEntries(join(dataDir, "tools.d"))) byId.set(entry.id, entry);
  return [...byId.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

export function findCatalogEntry(catalog: CatalogEntry[], id: string): CatalogEntry | undefined {
  return catalog.find((entry) => entry.id === id);
}

export function requireCatalogEntry(catalog: CatalogEntry[], id: string): CatalogEntry {
  const entry = findCatalogEntry(catalog, id);
  if (!entry) throw badRequest(msg("tool_unknown", { id }));
  if (entry.needsRoot) throw badRequest(msg("tool_needs_root", { id }));
  return entry;
}
