import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { requireCatalogEntry } from "./catalog";
import type { CatalogEntry } from "./types";

/** After create/rebuild: record desired tools on the spec (create path) without installing yet. */
export function desiredToolsOf(ids: string[] | undefined, catalog: CatalogEntry[]): { id: string; version: string }[] {
  if (!ids?.length) return [];
  if (ids.length > 32) throw badRequest(msg("tool_ids_invalid"));
  const seen = new Set<string>();
  const out: { id: string; version: string }[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw badRequest(msg("tool_ids_invalid"));
    requireCatalogEntry(catalog, id);
    seen.add(id);
    out.push({ id, version: "latest" });
  }
  return out;
}
