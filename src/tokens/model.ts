import { LOCAL_HOST_ID } from "../host/registry";
import { AppError } from "../lib/errors";
import { type MessageKey, msg, type Params } from "../lib/messages";
import type { BoxSpec } from "../specs/types";

/**
 * Scopes a token may carry. Operations keep their own scope strings; `requiredScopes` maps those onto this list.
 * Anything that maps to no scope here is the owner's alone: token management, pool administration, pool listing,
 * template build, task cancellation, the console's session and system routes.
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
  "volume:read",
  "volume:write",
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

/** Volume grants name volume records by id (`vol_…`), never by name. `all` covers every volume the token may see. */
export type VolumeScope = { readonly type: "list"; readonly ids: string[] } | { readonly type: "all" };
export type HostScope = { readonly type: "list"; readonly ids: string[] } | { readonly type: "all" };

/** Null means the limit is not set. `maxTtlSec` caps the TTL stored on a box; the lifecycle watcher enforces expiry. */
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

/** The parts of a box the authorizer and the event filter need. `boxId` is the stable `bx_…` id. */
export interface BoxView {
  readonly boxId: string;
  readonly containerId?: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly labels: Record<string, string>;
  readonly hostId?: string;
  /** ISO time the box was created, when the view comes from its spec. Events by name count from then on. */
  readonly createdAt?: string;
}

/** A volume record as the grant rules see it. */
export interface VolumeView {
  readonly id: string;
  readonly createdBy: string | null;
  readonly ownerBoxId: string | null;
  readonly role: string | null;
}

/** A principal as the rules see it. The owner has no grants, and every rule passes it through. */
export interface Subject {
  readonly type: string;
  readonly id: string;
  readonly grants?: TokenGrants;
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
const OPERATOR_SCOPES: readonly Scope[] = [...SCOPES];
const SANDBOX_SCOPES: readonly Scope[] = OPERATOR_SCOPES.filter(
  (scope) => scope !== "volume:attach" && scope !== "tool:install",
);

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
const NO_VOLUMES: VolumeScope = { type: "list", ids: [] };

/** Agent tokens get this prefix. The owner's principal id is `owner`, and no other principal uses the prefix. */
export const TOKEN_ID_PREFIX = "tok_";

export function isTokenId(id: string): boolean {
  return id.startsWith(TOKEN_ID_PREFIX);
}

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
        volumes: NO_VOLUMES,
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
  const grantsVolumes = volumes.type === "all" || volumes.ids.length > 0;
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

/**
 * What an operation's scope string requires of a token: any one of the listed scopes. `"owner"` means no token may
 * use it. Every scope string an operation declares is listed here or falls through to `"owner"`, so a new operation
 * is owner-only until someone decides otherwise.
 */
export function requiredScopes(operationScope: string): readonly Scope[] | "owner" {
  switch (operationScope) {
    case "box:read":
    case "events:read":
    case "task:read":
    case "template:read":
      return ["box:read"];
    case "box:write":
      return ["box:write"];
    case "box:delete":
      return ["box:delete"];
    case "box:exec":
    case "box:session":
    case "exec":
      return ["exec"];
    case "snapshot:read":
    case "checkpoint:read":
      return ["box:read", "checkpoint:create", "checkpoint:restore"];
    case "snapshot:write":
    case "snapshot:delete":
    case "checkpoint:create":
    case "checkpoint:write":
    case "checkpoint:delete":
      return ["checkpoint:create"];
    case "checkpoint:restore":
      return ["checkpoint:restore"];
    case "template:write":
    case "template:delete":
    case "tool:install":
      return ["tool:install"];
    case "volume:read":
      return ["volume:read"];
    case "volume:write":
      return ["volume:write"];
    case "volume:attach":
      return ["volume:attach"];
    case "files:read":
      return ["files:read", "exec"];
    case "files:write":
      return ["files:write", "exec"];
    case "port:expose":
      return ["port:expose"];
    default:
      return "owner";
  }
}

export function scopeAllowed(grants: TokenGrants, operationScope: string): boolean {
  const need = requiredScopes(operationScope);
  if (need === "owner") return false;
  return need.some((scope) => grants.scopes.includes(scope));
}

/** Fail-closed: a box or volume with no host recorded is not on any host a token may use, unless every host is granted. */
export function hostAllowed(hosts: HostScope, hostId: string | undefined): boolean {
  if (hosts.type === "all") return true;
  if (hostId === undefined) return false;
  return hosts.ids.includes(hostId);
}

function tagMatches(labels: Record<string, string>, tag: string): boolean {
  const eq = tag.indexOf("=");
  if (eq === -1) return Object.hasOwn(labels, tag);
  return labels[tag.slice(0, eq)] === tag.slice(eq + 1);
}

/** Whether this principal may see or act on the box. The owner sees every box. */
export function boxVisible(principal: Subject, box: BoxView): boolean {
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
      return boxes.ids.includes(box.boxId);
    case "tags":
      return boxes.tags.some((tag) => tagMatches(box.labels, tag));
    default:
      return false;
  }
}

export function viewOfSpec(spec: BoxSpec): BoxView {
  return {
    boxId: spec.id,
    containerId: spec.containerId,
    name: spec.name,
    createdBy: spec.createdBy,
    labels: spec.labels,
    hostId: spec.hostId,
    createdAt: spec.createdAt,
  };
}

export function specViews(specs: readonly BoxSpec[]): BoxView[] {
  return specs.map(viewOfSpec);
}

/** Every box view across the hosts, so a grant that names a box on any host resolves the same way. */
export function allBoxViews(hosts: readonly { readonly specs: { list(): readonly BoxSpec[] } }[]): BoxView[] {
  return hosts.flatMap((host) => specViews(host.specs.list()));
}

/**
 * `exec` grants read and write on every mount of a box the token may use, so `files:*` only changes what a token
 * without `exec` can do. Volume file operations use the same rule via their `files:read` / `files:write` scopes.
 */
export function fileAccess(principal: Subject, box: BoxView): { read: boolean; write: boolean } {
  if (principal.type === "owner") return { read: true, write: true };
  if (principal.type !== "token" || !principal.grants || !boxVisible(principal, box)) {
    return { read: false, write: false };
  }
  const exec = principal.grants.scopes.includes("exec");
  return {
    read: exec || principal.grants.scopes.includes("files:read"),
    write: exec || principal.grants.scopes.includes("files:write"),
  };
}

export function canExec(principal: Subject, box: BoxView): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  return principal.grants.scopes.includes("exec") && boxVisible(principal, box);
}

/**
 * Whether a token may see or use a volume record. The creator may, a grant by id may, a box it may see may (its owned
 * volumes), and `volumes: all` covers every volume except another token's. Names never decide.
 */
export function volumeVisible(principal: Subject, volume: VolumeView, boxes: readonly BoxView[] = []): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (volume.createdBy === principal.id) return true;
  const grant = principal.grants.volumes;
  if (grant.type === "list") {
    if (grant.ids.includes(volume.id)) return true;
  } else if (!(volume.createdBy !== null && isTokenId(volume.createdBy))) {
    return true;
  }
  if (volume.ownerBoxId === null) return false;
  return boxes.some((box) => box.boxId === volume.ownerBoxId && boxVisible(principal, box));
}

/**
 * Whether a token may write a volume. The shared tools volume is read-only for everyone but the owner, so a token can
 * attach it read-only and cannot mount it read-write.
 */
export function volumeWritable(principal: Subject, volume: VolumeView, boxes: readonly BoxView[] = []): boolean {
  if (principal.type === "owner") return true;
  if (volume.role === "tools") return false;
  return volumeVisible(principal, volume, boxes);
}

/**
 * TTL stored on a new box. A token with `maxTtlSec` that omits TTL, or sends null, gets that cap. The lifecycle
 * watcher stops the box when the TTL elapses (#12); this only records the limit.
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

/** The parts of a box that `viewOfBox` reads. Live boxes and specs both have them. */
export interface BoxLike {
  readonly boxId: string;
  readonly id: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly labels: Record<string, string>;
}

export function viewOfBox(box: BoxLike, hostId: string): BoxView {
  return {
    boxId: box.boxId,
    containerId: box.id,
    name: box.name,
    createdBy: box.createdBy,
    labels: box.labels,
    hostId,
  };
}

/** A snapshot or template as the rules see it. `sourceId` is the stable id of the box it was taken from. */
export interface ImageView {
  readonly createdBy: string | null;
  readonly sourceId: string | null;
}

/**
 * A snapshot is visible to its creator, to a token whose boxes include its source box, and to every token whose boxes
 * are `all`. A snapshot with no source id is visible only to its creator. Matching is by stable id, never by name.
 */
export function snapshotVisible(principal: Subject, image: ImageView, boxes: readonly BoxView[]): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (principal.grants.boxes.type === "all") return true;
  if (image.createdBy === principal.id) return true;
  if (image.sourceId === null) return false;
  return boxes.some((box) => box.boxId === image.sourceId && boxVisible(principal, box));
}

/** A task is visible to the token that started it, and to a token that may see the box it targets. */
export function taskVisible(
  principal: Subject,
  task: { readonly principalId: string; readonly target?: { readonly kind: string; readonly id?: string } },
  boxes: readonly BoxView[],
): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (task.principalId === principal.id) return true;
  const target = task.target;
  if (!target || target.kind !== "box" || target.id === undefined) return false;
  const id = target.id;
  return boxes.some((box) => (box.boxId === id || box.containerId === id) && boxVisible(principal, box));
}

/**
 * A template is visible to every token when the owner made it, and to the token that promoted it. Another token's
 * template is not visible, whatever its boxes grant.
 */
export function templateVisible(principal: Subject, image: { readonly createdBy: string | null }): boolean {
  if (principal.type === "owner") return true;
  if (principal.type !== "token" || !principal.grants) return false;
  if (image.createdBy === null || !isTokenId(image.createdBy)) return true;
  return image.createdBy === principal.id;
}

/** The refusal an authorize rule raises: a 403 whose message says which part of the credential's scope it missed. */
export function refusal(key: MessageKey, params?: Params): AppError {
  return new AppError(403, "forbidden", msg(key, params));
}

/** Security profiles from the least to the most hardened. A null profile (legacy boxes) is looser than all of them. */
const PROFILE_RANK: Record<string, number> = { relaxed: 1, standard: 2, strict: 3 };

export function profileRank(profile: string | null): number {
  return profile === null ? 0 : (PROFILE_RANK[profile] ?? 0);
}

/** Tokens create and rebuild only with `standard` or `strict`. Relaxed and legacy profiles belong to the owner. */
export const TOKEN_MIN_PROFILE_RANK = PROFILE_RANK.standard ?? 2;

/** Other principals (the owner) may choose any profile, so this only constrains tokens. */
export function profileForToken(profile: string): boolean {
  return profileRank(profile) >= TOKEN_MIN_PROFILE_RANK;
}

/** Quota usage for a token: the boxes its own record created, across every host. */
export function ownedBoxes(principal: Subject, specs: readonly BoxSpec[]): BoxSpec[] {
  return specs.filter((spec) => spec.createdBy === principal.id);
}
