import { AppError, badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import {
  type PoolBackend,
  type PoolCapabilities,
  type PoolsFile,
  POOLS_VERSION,
  type RolePools,
  type StoragePool,
  type VolumeRecord,
  type VolumeRole,
  VOLUME_ROLES,
  DEFAULT_MARKER,
  LOCAL_POOL,
} from "./types";

const NFS_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/;
const OPTION_TOKEN = /^[A-Za-z0-9._=-]{1,64}$/;
const MARKER_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const ABSOLUTE_PATH = /^\/[^\s\0]{0,240}$/;

function capabilitiesFor(backend: PoolBackend): PoolCapabilities {
  return {
    shareable: true,
    snapshots: false,
    quota: false,
    clone: false,
    crossHost: backend === "nfs",
  };
}

function localPool(isDefault: boolean): StoragePool {
  return {
    name: LOCAL_POOL,
    backend: "local",
    default: isDefault,
    server: null,
    export: null,
    options: [],
    root: null,
    marker: null,
    capabilities: capabilitiesFor("local"),
  };
}

export function implicitPools(): PoolsFile {
  return {
    version: POOLS_VERSION,
    pools: [localPool(true)],
    roles: { workspace: null, home: null, tools: null, cache: null },
  };
}

export function poolForRole(file: PoolsFile, role: VolumeRole): StoragePool {
  const named = file.roles[role];
  const chosen = named ? file.pools.find((pool) => pool.name === named) : undefined;
  if (chosen) return chosen;
  if (role === "cache") {
    const local =
      file.pools.find((pool) => pool.name === LOCAL_POOL && pool.backend === "local") ??
      file.pools.find((pool) => pool.backend === "local");
    if (local) return local;
  }
  return file.pools.find((pool) => pool.default) ?? file.pools[0] ?? localPool(true);
}

export interface PoolDraft {
  name: string;
  backend: PoolBackend;
  default?: boolean;
  server?: string;
  export?: string;
  options?: string[];
  root?: string;
  marker?: string;
}

export interface RoleDraft {
  workspace?: string | null;
  home?: string | null;
  tools?: string | null;
  cache?: string | null;
}

function fail(key: Parameters<typeof msg>[0], params?: Parameters<typeof msg>[1]): never {
  throw badRequest(msg(key, params));
}

function cleanPath(value: string, what: string): string {
  const path = value.trim();
  if (!ABSOLUTE_PATH.test(path) || path.split("/").includes("..")) {
    throw new AppError(400, "validation_failed", msg("pool_path_invalid", { what, path: value }));
  }
  return path.replace(/\/+$/, "") || "/";
}

function normalizePool(draft: PoolDraft): StoragePool {
  const name = draft.name.trim();
  if (!NAME_RE.test(name)) fail("name_invalid", { label: "name" });
  if (draft.backend !== "local" && draft.backend !== "nfs" && draft.backend !== "path") {
    fail("pool_backend_invalid", { pool: name });
  }
  if (name === LOCAL_POOL && draft.backend !== "local") fail("pool_local_backend");

  const pool: StoragePool = {
    name,
    backend: draft.backend,
    default: draft.default === true,
    server: null,
    export: null,
    options: [],
    root: null,
    marker: null,
    capabilities: capabilitiesFor(draft.backend),
  };

  if (draft.backend === "nfs") {
    const server = draft.server?.trim() ?? "";
    const exportPath = draft.export?.trim() ?? "";
    if (!NFS_TOKEN.test(server) || !ABSOLUTE_PATH.test(exportPath)) fail("nfs_pool_invalid", { pool: name });
    const options = draft.options ?? [];
    if (options.length > 16 || options.some((option) => !OPTION_TOKEN.test(option))) {
      fail("nfs_options_invalid", { pool: name });
    }
    pool.server = server;
    pool.export = cleanPath(exportPath, "export");
    pool.options = options;
  }

  if (draft.backend === "path") {
    const root = draft.root?.trim() ?? "";
    if (!ABSOLUTE_PATH.test(root)) fail("path_pool_invalid", { pool: name });
    const marker = (draft.marker?.trim() || DEFAULT_MARKER).replace(/^\.\//, "");
    if (!MARKER_NAME.test(marker) || marker === "." || marker === "..") fail("marker_invalid");
    pool.root = cleanPath(root, "root");
    pool.marker = marker;
  }

  return pool;
}

/**
 * The saved pool list. The local pool is put back if the request omitted it, and exactly one pool is default.
 * A pool that still has volumes cannot disappear or change backend: existing engine volumes keep the options
 * they were created with.
 */
export function normalizePools(drafts: PoolDraft[], roles: RoleDraft | undefined, volumes: VolumeRecord[]): PoolsFile {
  const pools = drafts.map(normalizePool);
  if (pools.some((pool, index) => pools.findIndex((other) => other.name === pool.name) !== index)) {
    fail("pool_duplicate");
  }
  if (!pools.some((pool) => pool.name === LOCAL_POOL)) pools.push(localPool(false));

  const defaults = pools.filter((pool) => pool.default);
  if (defaults.length > 1) fail("pool_default_conflict");
  if (defaults.length === 0) {
    const local = pools.find((pool) => pool.name === LOCAL_POOL);
    if (local) local.default = true;
    else fail("pool_default_conflict");
  }

  const names = new Set(pools.map((pool) => pool.name));
  for (const volume of volumes) {
    if (!names.has(volume.pool)) fail("pool_in_use", { pool: volume.pool });
  }

  const nextRoles: RolePools = { workspace: null, home: null, tools: null, cache: null };
  for (const role of VOLUME_ROLES) {
    const value = roles?.[role];
    if (value === undefined || value === null || value === "") continue;
    if (!names.has(value)) fail("role_pool_unknown", { role, pool: value });
    nextRoles[role] = value;
  }

  return { version: POOLS_VERSION, pools, roles: nextRoles };
}

/** Driver options for a Docker local volume that mounts an NFS export. Probe mounts are soft so a dead server cannot hang. */
export function nfsDriverOpts(pool: StoragePool, subpath: string | null, probe: boolean): Record<string, string> {
  const server = pool.server ?? "";
  const base = pool.export ?? "/";
  const device = subpath ? `${base.replace(/\/$/, "")}/${subpath}` : base;
  const user = pool.options.filter((option) => option !== "hard" && option !== "soft");
  const options = probe ? ["soft", "timeo=10", "retrans=1", ...user] : pool.options;
  return { type: "nfs", o: [`addr=${server}`, ...options].join(","), device: `:${device}` };
}

/** A path pool is a bind expressed as a Docker volume, so a missing marker fails the mount instead of writing the local disk. */
export function pathDriverOpts(pool: StoragePool, subpath: string): Record<string, string> {
  const root = pool.root ?? "/";
  return { type: "none", o: "bind", device: `${root.replace(/\/$/, "")}/${subpath}` };
}

export function sameOptions(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
  const a = left ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(right)]);
  for (const key of keys) if (a[key] !== right[key]) return false;
  return true;
}
