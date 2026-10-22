/** On-disk schema version of `DATA_DIR/volumes/<id>.json` and `DATA_DIR/pools.json`. */
export const VOLUME_VERSION = 1;
export const POOLS_VERSION = 1;

export const VOLUME_ROLES = ["workspace", "home", "tools", "cache"] as const;
export type VolumeRole = (typeof VOLUME_ROLES)[number];

export type VolumeOwnership = "owned" | "independent";
export type PoolBackend = "local" | "nfs" | "path";
export type PoolReachability = "reachable" | "unreachable" | "unknown";

/** What the backend can actually do. The console hides actions a pool cannot perform. */
export interface PoolCapabilities {
  shareable: boolean;
  snapshots: boolean;
  quota: boolean;
  clone: boolean;
  crossHost: boolean;
}

/**
 * One storage pool. The file is control-plane config, shared by every host: a volume record says which host
 * created the engine volume. `local` is always present so cache has somewhere to land.
 */
export interface StoragePool {
  name: string;
  backend: PoolBackend;
  default: boolean;
  server: string | null;
  export: string | null;
  options: string[];
  root: string | null;
  /** File that must exist under `root` before a path pool is written to. Null for other backends. */
  marker: string | null;
  capabilities: PoolCapabilities;
}

/** Null means "use the rule": cache goes to the local pool, everything else to the default pool. */
export interface RolePools {
  workspace: string | null;
  home: string | null;
  tools: string | null;
  cache: string | null;
}

export interface PoolsFile {
  version: typeof POOLS_VERSION;
  pools: StoragePool[];
  roles: RolePools;
}

/**
 * A volume MiniBox knows about. The engine name is what Docker mounts; `name` is what people see.
 * Records live under DATA_DIR, not on the engine, so a host can be added later without renaming volumes.
 */
export interface VolumeRecord {
  version: typeof VOLUME_VERSION;
  id: string;
  name: string;
  hostId: string;
  pool: string;
  role: VolumeRole | null;
  ownership: VolumeOwnership;
  /** Set when `ownership` is `owned`: deleting that box may delete the volume. Independent volumes never follow a box. */
  ownerBoxId: string | null;
  /** Home volumes hold credentials. Checkpoints and exports treat them as sensitive. */
  sensitive: boolean;
  /** Cache volumes are disposable and stay out of checkpoints. */
  checkpoint: boolean;
  engineName: string;
  /** Directory under an nfs export or a path root. Null for a plain local volume. */
  subpath: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  bytes: number | null;
  bytesAt: string | null;
  limits: VolumeLimits;
}

export type LimitAction = "warn" | "stop";

/**
 * A volume's usage limits, in bytes. Null is no limit. Soft limits are best effort: they are checked on each sample,
 * so usage can pass one between samples. `action` is what happens over the hard limit.
 */
export interface VolumeLimits {
  softBytes: number | null;
  hardBytes: number | null;
  action: LimitAction;
}

export const UNLIMITED: Readonly<VolumeLimits> = { softBytes: null, hardBytes: null, action: "warn" };

/** Where a usage figure falls against the limits. `unknown` until the volume has been sampled. */
export type UsageLevel = "unknown" | "ok" | "soft" | "hard";

/**
 * What a sample measured. A volume on a local or path pool is measured with `du`, so it is the volume's own tree. An NFS
 * volume is measured with `df` on the pool root, so it is the usage of the whole share it sits in.
 */
export type UsageScope = "volume" | "share";

export interface UsagePoint {
  at: string;
  bytes: number;
}

/** The last reading of the host's disk, as the engine host reports it. */
export interface HostDisk {
  totalBytes: number;
  freeBytes: number;
  /** Epoch milliseconds of the reading. */
  at: number;
}

export interface PoolHealth {
  pool: string;
  hostId: string;
  status: PoolReachability;
  message: string | null;
  checkedAt: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  /** Free space under 10% or under 5 GiB. */
  lowSpace: boolean;
}

export const LOCAL_POOL = "local";
export const DEFAULT_MARKER = ".minibox-mounted";
/** uid:gid of the `dev` user in the base template. New volumes are handed to this owner. */
export const DEV_OWNER = "1000:1000";

export const ROLE_MOUNT: Record<VolumeRole, { path: string; mode: "rw" | "ro" }> = {
  workspace: { path: "/workspace", mode: "rw" },
  home: { path: "/home/dev", mode: "rw" },
  tools: { path: "/opt/minibox/tools", mode: "ro" },
  cache: { path: "/home/dev/.cache", mode: "rw" },
};
