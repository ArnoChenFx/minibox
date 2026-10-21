import { LOCAL_HOST_ID } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import type { BoxSpec } from "../specs/types";

/**
 * Scopes a token may carry. Operations keep their own scope strings; `requiredScopes` maps those onto this list.
 * `token:manage` is not here: creating and revoking tokens stays with the owner credential.
 */
export const SCOPES = [
  "box:read",
  "box:write",
  "box:delete",
  "exec",
  "files:read",
  "files:write",
  "port:expose",
  "checkpoint:create",
  "checkpoint:restore",
  "volume:attach",
  "tool:install",
] as const;

export type Scope = (typeof SCOPES)[number];

export const PRESET_NAMES = ["readonly", "operator", "sandboxed-agent", "admin"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export type BoxScope =
  | { readonly type: "created-by-me" }
  | { readonly type: "ids"; readonly ids: string[] }
  | { readonly type: "tags"; readonly tags: string[] }
  | { readonly type: "all" };

export type VolumeScope = { readonly type: "list"; readonly names: string[] } | { readonly type: "all" };
export type HostScope = { readonly type: "list"; readonly ids: string[] } | { readonly type: "all" };

/** Null means the limit is not set. `maxTtlSec` caps the TTL stored on a box; expiry itself is #12. */
export interface Quotas {
  readonly maxBoxes: number | null;
  readonly maxCpus: number | null;
  readonly maxMemoryMb: number | null;
  readonly maxTtlSec: number | null;
  readonly rateLimit: number | null;
  readonly rateWindowSec: number | null;
}

export const NO_QUOTA: Quotas = {
  maxBoxes: null,
  maxCpus: null,
  maxMemoryMb: null,
  maxTtlSec: null,
  rateLimit: null,
  rateWindowSec: null,
};

export interface TokenGrants {
  readonly scopes: readonly Scope[];
  readonly boxes: BoxScope;
  readonly volumes: VolumeScope;
  readonly hosts: HostScope;
  readonly quotas: Quotas;
  /**
   * `all` reads the whole event log. Only an unmodified admin preset has it. Every other token sees events about
   * boxes in its scope, plus events it caused itself.
   */
  readonly audit: "all" | "scoped";
}

/** The parts of a box the authorizer and the event filter need. */
export interface BoxView {
  readonly boxId: string;
  readonly containerId?: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly labels: Record<string, string>;
  readonly hostId?: string;
  readonly mounts?: readonly { readonly volume: string }[];
}

export interface TokenCreateInput {
  readonly name: string;
  readonly preset?: PresetName;
  readonly scopes?: readonly Scope[];
  readonly boxes?: BoxScope;
  readonly volumes?: VolumeScope;
  readonly hosts?: HostScope;
  readonly quotas?: Partial<Quotas>;
  readonly expiresInSec?: number | null;
}

/** A validated token, ready to store. `audit` is derived and not accepted from the client. */
export interface TokenDraft {
  readonly name: string;
  readonly preset: PresetName | null;
  readonly scopes: readonly Scope[];
  readonly boxes: BoxScope;
  readonly volumes: VolumeScope;
  readonly hosts: HostScope;
  readonly quotas: Quotas;
  readonly audit: "all" | "scoped";
  readonly expiresInSec: number | null;
}

const READ_SCOPES: readonly Scope[] = ["box:read", "files:read"];
const OPERATOR_SCOPES: readonly Scope[] = [
  "box:read",
  "box:write",
  "box:delete",
  "exec",
  "files:read",
  "files:write",
  "port:expose",
  "checkpoint:create",
  "checkpoint:restore",
  "volume:attach",
  "tool:install",
];
const SANDBOX_SCOPES: readonly Scope[] = [
  "box:read",
  "box:write",
  "box:delete",
  "exec",
  "files:read",
  "files:write",
  "port:expose",
  "checkpoint:create",
  "checkpoint:restore",
];

/** Five boxes, 8 CPU cores and 16 GB between them, four hours, one request a second sustained. */
const SANDBOX_QUOTA: Quotas = {
  maxBoxes: 5,
  maxCpus: 8,
  maxMemoryMb: 16_384,
  maxTtlSec: 4 * 60 * 60,
  rateLimit: 60,
  rateWindowSec: 60,
};

const CREATED_BY_ME: BoxScope = { type: "created-by-me" };
const LOCAL_HOSTS: HostScope = { type: "list", ids: [LOCAL_HOST_ID] };
const NO_VOLUMES: VolumeScope = { type: "list", names: [] };

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function isPreset(value: string): value is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(value);
}

/** The policy a preset starts from. Callers may override any part except `audit`. */
export function presetPolicy(name: PresetName): Omit<TokenDraft, "name" | "preset" | "audit" | "expiresInSec"> {
  switch (name) {
    case "readonly":
      return { scopes: READ_SCOPES, boxes: CREATED_BY_ME, volumes: NO_VOLUMES, hosts: LOCAL_HOSTS, quotas: NO_QUOTA };
    case "operator":
      return {
        scopes: OPERATOR_SCOPES,
        boxes: CREATED_BY_ME,
        volumes: NO_VOLUMES,
        hosts: LOCAL_HOSTS,
        quotas: NO_QUOTA,
      };
    case "sandboxed-agent":
      return {
        scopes: SANDBOX_SCOPES,
        boxes: CREATED_BY_ME,
        volumes: NO_VOLUMES,
        hosts: LOCAL_HOSTS,
        quotas: SANDBOX_QUOTA,
      };
    case "admin":
      return {
        scopes: SCOPES,
        boxes: { type: "all" },
        volumes: { type: "all" },
        hosts: { type: "all" },
        quotas: NO_QUOTA,
      };
  }
}

function mergeQuotas(base: Quotas, patch: Partial<Quotas> | undefined): Quotas {
  if (!patch) return { ...base };
  const pick = (key: keyof Quotas): number | null => (patch[key] === undefined ? base[key] : patch[key]);
  return {
    maxBoxes: pick("maxBoxes"),
    maxCpus: pick("maxCpus"),
    maxMemoryMb: pick("maxMemoryMb"),
    maxTtlSec: pick("maxTtlSec"),
    rateLimit: pick("rateLimit"),
    rateWindowSec: pick("rateWindowSec"),
  };
}

/**
 * Preset plus overrides. A volume grant adds `volume:attach` when the preset did not have it, so naming a volume
 * cannot be stored and then ignored. A rate limit without a window uses 60 seconds.
 */
export function compileToken(input: TokenCreateInput): TokenDraft {
  const preset = input.preset ?? null;
  const base = preset
    ? presetPolicy(preset)
    : {
        scopes: [] as readonly Scope[],
        boxes: CREATED_BY_ME,
        volumes: NO_VOLUMES,
        hosts: LOCAL_HOSTS,
        quotas: NO_QUOTA,
      };
  const scopes = [...(input.scopes ?? base.scopes)];
  if (scopes.length === 0) {
    throw new AppError(400, "validation_failed", msg("token_scope_required"), { field: "scopes" });
  }
  const boxes = input.boxes ?? base.boxes;
  const volumes = input.volumes ?? base.volumes;
  const hosts = input.hosts ?? base.hosts;
  const grantsVolumes = volumes.type === "all" || volumes.names.length > 0;
  if (grantsVolumes && !scopes.includes("volume:attach")) scopes.push("volume:attach");
  let quotas = mergeQuotas(base.quotas, input.quotas);
  if (quotas.rateLimit === null && input.quotas?.rateWindowSec != null) {
    throw new AppError(400, "validation_failed", msg("token_quota_invalid"), { field: "quotas" });
  }
  if (quotas.rateLimit !== null && quotas.rateWindowSec === null) quotas = { ...quotas, rateWindowSec: 60 };
  const scopesOverridden = input.scopes !== undefined;
  const audit: TokenDraft["audit"] =
    preset === "admin" && !scopesOverridden && boxes.type === "all" && hosts.type === "all" ? "all" : "scoped";
  return {
    name: input.name,
    preset,
    scopes,
    boxes,
    volumes,
    hosts,
    quotas,
    audit,
    expiresInSec: input.expiresInSec ?? null,
  };
}

/** What an operation's scope string requires of a token. Unknown scopes stay with the owner. */
export function requiredScopes(operationScope: string): readonly Scope[] | "owner" {
  switch (operationScope) {
    case "box:read":
    case "events:read":
    case "template:read":
      return ["box:read"];
    case "box:write":
      return ["box:write"];
    case "box:delete":
      return ["box:delete"];
    case "snapshot:read":
      return ["checkpoint:create", "checkpoint:restore", "box:read"];
    case "snapshot:write":
    case "checkpoint:create":
    case "snapshot:delete":
      return ["checkpoint:create"];
    case "checkpoint:restore":
      return ["checkpoint:restore"];
    case "template:write":
    case "template:delete":
    case "tool:install":
      return ["tool:install"];
    case "exec":
      return ["exec"];
    case "files:read":
      return ["files:read", "exec"];
    case "files:write":
      return ["files:write", "exec"];
    case "port:expose":
      return ["port:expose"];
    case "volume:attach":
      return ["volume:attach"];
    default:
      return "owner";
  }
}

export function scopeAllowed(grants: TokenGrants, operationScope: string): boolean {
  const need = requiredScopes(operationScope);
  if (need === "owner") return false;
  return need.some((scope) => grants.scopes.includes(scope));
}

export function hostAllowed(hosts: HostScope, hostId: string | undefined): boolean {
  if (hosts.type === "all" || hostId === undefined) return true;
  return hosts.ids.includes(hostId);
}

function tagMatches(labels: Record<string, string>, tag: string): boolean {
  const eq = tag.indexOf("=");
  if (eq === -1) return Object.hasOwn(labels, tag);
  return labels[tag.slice(0, eq)] === tag.slice(eq + 1);
}

/** Whether this principal may see or act on the box. The owner sees every box. */
export function boxVisible(principal: { type: string; id: string; grants?: TokenGrants }, box: BoxView): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (!hostAllowed(principal.grants.hosts, box.hostId)) return false;
  const boxes = principal.grants.boxes;
  switch (boxes.type) {
    case "all":
      return true;
    case "created-by-me":
      return box.createdBy === principal.id;
    case "ids":
      return (
        boxes.ids.includes(box.boxId) ||
        boxes.ids.includes(box.name) ||
        (box.containerId !== undefined && boxes.ids.includes(box.containerId))
      );
    case "tags":
      return boxes.tags.some((tag) => tagMatches(box.labels, tag));
    default:
      return false;
  }
}

/**
 * `exec` grants read and write on every mount of a box the token may use, so `files:*` only changes what a token
 * without `exec` can do. There is no file API yet; later operations call this instead of re-deciding.
 */
export function fileAccess(
  principal: { type: string; id: string; grants?: TokenGrants },
  box: BoxView,
): { read: boolean; write: boolean } {
  if (principal.type === "owner") return { read: true, write: true };
  if (principal.type !== "token" || !principal.grants || !boxVisible(principal, box))
    return { read: false, write: false };
  const exec = principal.grants.scopes.includes("exec");
  return {
    read: exec || principal.grants.scopes.includes("files:read"),
    write: exec || principal.grants.scopes.includes("files:write"),
  };
}

export function canExec(principal: { type: string; id: string; grants?: TokenGrants }, box: BoxView): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  return principal.grants.scopes.includes("exec") && boxVisible(principal, box);
}

/** Mounting needs `volume:attach` and the volume in the grant. `*` grants every volume. */
export function volumeGranted(principal: { type: string; grants?: TokenGrants }, volume: string): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (!principal.grants.scopes.includes("volume:attach")) return false;
  if (principal.grants.volumes.type === "all") return true;
  return principal.grants.volumes.names.includes(volume);
}

/** Volume names an operation input asks to mount. The workspace volume created for a new box is not one of these. */
export function volumesNamed(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const names: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value !== "") names.push(value);
  };
  if (Array.isArray(input.mounts)) {
    for (const mount of input.mounts) {
      if (typeof mount === "object" && mount !== null && "volume" in mount) push(mount.volume);
    }
  }
  if (Array.isArray(input.volumes)) {
    for (const volume of input.volumes) push(volume);
  }
  push(input.volume);
  return [...new Set(names)];
}

/**
 * TTL stored on a new box. A token with `maxTtlSec` that omits TTL gets that cap. Stopping the box when it elapses
 * is #12; this only records the limit the quota already enforced.
 */
export function ttlFor(
  principal: { type: string; grants?: TokenGrants },
  requested: number | null | undefined,
): number | null {
  if (principal.type !== "token") return requested ?? null;
  const max = principal.grants?.quotas.maxTtlSec ?? null;
  if (requested === undefined || requested === null) return max;
  return requested;
}

/** A snapshot is visible when its source box is, or when the token may see every box. The owner sees all of them. */
export function snapshotVisible(
  principal: { type: string; id: string; grants?: TokenGrants },
  source: string | null,
  boxes: readonly BoxView[],
): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (principal.grants.boxes.type === "all") return true;
  if (!source) return false;
  return boxes.some((box) => box.name === source && boxVisible(principal, box));
}

/** Specs as the authorizer and the event filter see them. Container id and stable id are both included. */
export function viewsFromSpecs(specs: readonly BoxSpec[]): BoxView[] {
  return specs.map((spec) =>
    viewFromBox({
      boxId: spec.id,
      containerId: spec.containerId,
      name: spec.name,
      createdBy: spec.createdBy,
      labels: spec.labels,
      hostId: spec.hostId,
      mounts: spec.mounts,
    }),
  );
}

export function viewFromBox(box: {
  boxId: string;
  id?: string;
  containerId?: string;
  name: string;
  createdBy: string | null;
  labels: Record<string, string>;
  hostId?: string;
  mounts?: readonly { volume: string }[];
}): BoxView {
  return {
    boxId: box.boxId,
    containerId: box.containerId ?? box.id,
    name: box.name,
    createdBy: box.createdBy,
    labels: box.labels,
    hostId: box.hostId,
    mounts: box.mounts,
  };
}
