/**
 * The storage-pool form: the values it starts from, the pool it produces, and the pool list it writes back to. Pure
 * apart from the shared `nameError` and `t`, so the page keeps no pool rules of its own and the tests can read them
 * without a browser. A pool's backend is fixed once it exists: the server refuses a backend change while volumes use
 * it, and the form never offers one.
 */

import { t } from "./i18n.js";
import { nameError } from "./ui.js";

/** The marker a path pool needs under its root unless another one is named. Mirrors `DEFAULT_MARKER` in src/volumes/types.ts. */
export const DEFAULT_MARKER = ".minibox-mounted";

/** One NFS option token. Mirrors `OPTION_TOKEN` in src/volumes/pools.ts. */
export const OPTION_RE = /^[A-Za-z0-9._=-]{1,64}$/;

/** Most options one pool takes. Mirrors the server's limit in src/volumes/pools.ts. */
export const OPTION_MAX = 16;

/** What a pool can do, by backend. Mirrors `capabilitiesFor` in src/volumes/pools.ts. */
function capabilitiesFor(backend) {
  return {
    shareable: true,
    snapshots: false,
    quota: false,
    clone: false,
    crossHost: backend === "nfs",
  };
}

/** The form values of a pool, or of a blank pool of the given backend. */
export function poolForm(pool = {}) {
  const backend = pool.backend ?? "nfs";
  return {
    name: pool.name ?? "",
    backend,
    server: pool.server ?? "",
    export: pool.export ?? "",
    options: (pool.options ?? []).join(", "),
    root: pool.root ?? "",
    marker: pool.marker ?? (backend === "path" ? DEFAULT_MARKER : ""),
    default: pool.default === true,
  };
}

/** The options a comma-separated field names, trimmed and without the empty entries. */
export function splitOptions(text) {
  return String(text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The pool a filled form describes, or the first thing wrong with it: `error` is the text to show and `field` the
 * input it belongs to. `pool` is the pool being edited, whose backend is kept, and `pools` the list the name must not
 * clash with. Validation follows the server, so a pool the form accepts is one `PUT /api/pools` accepts too.
 */
export function poolDraft(form, { pool = null, pools = [] } = {}) {
  const name = String(form.name ?? "").trim();
  const invalid = nameError(name, "name");
  if (invalid) return { error: invalid, field: "p-name" };
  const backend = pool?.backend ?? form.backend;
  if (name === "local" && backend !== "local") return { error: t("err.pool_local_backend"), field: "p-name" };
  if (pools.some((other) => other.name === name && other.name !== pool?.name)) {
    return { error: t("err.pool_duplicate"), field: "p-name" };
  }

  const draft = {
    name,
    backend,
    default: form.default === true,
    server: null,
    export: null,
    options: [],
    root: null,
    marker: null,
    capabilities: capabilitiesFor(backend),
  };

  if (backend === "nfs") {
    const server = String(form.server ?? "").trim();
    const exportPath = String(form.export ?? "").trim();
    if (!server || !exportPath) {
      return { error: t("err.nfs_pool_invalid", { pool: name }), field: server ? "p-export" : "p-server" };
    }
    const options = splitOptions(form.options);
    // The console asks for one option, as the guide does: a mount without `nfsvers=` falls back to NFSv3. The server
    // accepts an empty list, so this is the console's stricter rule.
    if (!options.length) return { error: t("vol.optionsRequired"), field: "p-options" };
    if (options.length > OPTION_MAX || options.some((option) => !OPTION_RE.test(option))) {
      return { error: t("err.nfs_options_invalid", { pool: name }), field: "p-options" };
    }
    draft.server = server;
    draft.export = exportPath;
    draft.options = options;
  }

  if (backend === "path") {
    const root = String(form.root ?? "").trim();
    if (!root) return { error: t("err.path_pool_invalid", { pool: name }), field: "p-root" };
    const marker = String(form.marker ?? "").trim() || DEFAULT_MARKER;
    draft.root = root;
    draft.marker = marker;
  }

  return { pool: draft };
}

/**
 * The pool list with `draft` in the place of the pool called `original`. A draft that is the default clears the flag on
 * every other pool, as the server needs exactly one.
 */
export function applyPoolDraft(pools, original, draft) {
  const next = pools.map((pool) => (pool.name === original ? { ...draft } : { ...pool }));
  return draft.default ? next.map((pool) => ({ ...pool, default: pool.name === draft.name })) : next;
}

/** The role defaults with every role that pointed at `from` pointing at `to`, so a rename keeps them. */
export function renameRole(roles, from, to) {
  return Object.fromEntries(Object.entries(roles).map(([role, pool]) => [role, pool === from ? to : pool]));
}

/** One line describing what a pool mounts, for the save preview. */
export function poolSummary(pool) {
  if (pool.backend === "nfs") {
    const options = (pool.options ?? []).join(",");
    return `nfs · ${pool.server ?? ""}:${pool.export ?? ""}${options ? ` · ${options}` : ""}`;
  }
  if (pool.backend === "path") return `path · ${pool.root ?? ""} · ${pool.marker ?? DEFAULT_MARKER}`;
  return "local";
}

/**
 * The pools whose parameters a save changes, as `{ name, from, to }` summaries. A pool that is only added, removed or
 * made default is left to the preview's own lines.
 */
export function poolChanges(before, after) {
  const known = new Map(before.map((pool) => [pool.name, pool]));
  return after.flatMap((pool) => {
    const previous = known.get(pool.name);
    if (!previous) return [];
    const from = poolSummary(previous);
    const to = poolSummary(pool);
    return from === to ? [] : [{ name: pool.name, from, to }];
  });
}
