import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../data-dir";
import { AppError } from "../lib/errors";
import { sha256 } from "../lib/hash";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { TokenPrincipal } from "../operations/types";
import {
  storageAdminPolicy,
  type BoxScope,
  type HostScope,
  isPreset,
  isScope,
  NO_QUOTA,
  type PresetName,
  type Quotas,
  type Scope,
  type TokenDraft,
  type TokenGrants,
  type VolumeScope,
} from "./model";

/** Live tokens kept at once. Revoked tokens are kept separately, up to the same number, newest first. */
const MAX_TOKENS = 100;
const SWEEP_MS = 10_000;
const SAVE_INTERVAL_MS = 60_000;
const FILE_VERSION = 1;
const SECRET_BYTES = 32;
const PREFIX_CHARS = 12;
const ADDRESS_MAX = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOKEN_ID = /^tok_[0-9a-f]{16}$/;
interface TokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  prefix: string;
  preset: PresetName | null;
  scopes: Scope[];
  boxes: BoxScope;
  volumes: VolumeScope;
  hosts: HostScope;
  quotas: Quotas;
  audit: "all" | "scoped";
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  createdBy: string;
  revokedAt: number | null;
}

/** A token as reported to callers. The secret and its hash are never included. */
export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  preset: PresetName | null;
  scopes: Scope[];
  boxes: BoxScope;
  volumes: VolumeScope;
  hosts: HostScope;
  quotas: Quotas;
  audit: "all" | "scoped";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdBy: string;
  revokedAt: string | null;
}

export interface TokenStoreOptions {
  /** Path of the token file, normally `DATA_DIR/tokens.json`. */
  file: string;
  /** Receives each new secret so the event log can redact it for the rest of this process. */
  secrets?: { add(secret: string): void };
  now?: () => number;
}

/**
 * Agent API tokens. The bearer string is random; the file keeps only its SHA-256 hash, the same way browser sessions
 * do, in a different file. Revocation removes the hash from the lookup map before the response is sent.
 * Rotating ACCESS_KEY does not revoke these: they are a separate credential, ended from Settings or this API.
 */
export class TokenStore {
  private readonly records: TokenRecord[] = [];
  private readonly live = new Map<string, TokenRecord>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private lastSaveAt = 0;
  private saveFailing = false;

  constructor(private readonly opts: TokenStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.restore();
    if (this.dirty) this.save();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  /**
   * Issues a token. The returned secret is the only copy; the file stores `sha256(secret)`.
   * `createdBy` is the principal id, `owner` for a token made from the console.
   */
  create(draft: TokenDraft, createdBy: string, now = this.now()): { secret: string; record: TokenInfo } {
    this.expireRecords(now);
    const live = this.records.filter((record) => record.revokedAt === null && this.isLive(record, now));
    if (live.length >= MAX_TOKENS) {
      throw new AppError(409, "conflict", msg("token_limit", { max: MAX_TOKENS }));
    }
    if (live.some((record) => record.name === draft.name)) {
      throw new AppError(409, "conflict", msg("token_name_taken", { name: draft.name }));
    }
    const secret = `mbx_${randomBytes(SECRET_BYTES).toString("base64url")}`;
    const record: TokenRecord = {
      id: `tok_${randomBytes(8).toString("hex")}`,
      name: draft.name,
      tokenHash: sha256(secret),
      prefix: secret.slice(0, PREFIX_CHARS),
      preset: draft.preset,
      scopes: [...draft.scopes],
      boxes: cloneBoxes(draft.boxes),
      volumes: cloneVolumes(draft.volumes),
      hosts: cloneHosts(draft.hosts),
      quotas: { ...draft.quotas },
      audit: draft.audit,
      createdAt: now,
      expiresAt: draft.expiresInSec === null ? null : now + draft.expiresInSec * 1000,
      lastUsedAt: null,
      lastUsedIp: null,
      createdBy,
      revokedAt: null,
    };
    this.records.push(record);
    this.live.set(record.tokenHash, record);
    this.opts.secrets?.add(secret);
    this.save();
    log.info("token.created", { tokenId: record.id, name: record.name, preset: record.preset });
    return { secret, record: toInfo(record) };
  }

  /** Every token, newest first, including revoked and expired ones. Secrets are not included. */
  list(): TokenInfo[] {
    return this.records.toSorted((a, b) => b.createdAt - a.createdAt).map(toInfo);
  }

  /**
   * The principal for a bearer secret, or null when it matches nothing live. A live token past its rate limit throws
   * 429 after the use is recorded, so a revoked token cannot be told apart from an unknown one by the status.
   */
  authenticate(secret: string, ip: string, now = this.now()): TokenPrincipal | null {
    if (secret === "") return null;
    const record = this.live.get(sha256(secret));
    if (!record || !this.isLive(record, now)) {
      if (record) this.end(record, now, false);
      return null;
    }
    this.markUsed(record, ip, now);
    this.consumeRate(record, now);
    return toPrincipal(record);
  }

  /** Ends a live token. Returns null when no live token has that id, so a second revoke is a 404. */
  revoke(id: string, now = this.now()): TokenInfo | null {
    const record = this.records.find((item) => item.id === id && item.revokedAt === null && this.isLive(item, now));
    if (!record) return null;
    this.end(record, now, true);
    log.info("token.revoked", { tokenId: id });
    this.save();
    return toInfo(record);
  }

  /**
   * Deletes the record of a token that is already over, revoked or expired. A live token is refused, so revoking stays
   * the one way to end a token. The activity log keeps the name and id the events recorded.
   */
  remove(
    id: string,
    now = this.now(),
  ): { status: "removed"; token: TokenInfo } | { status: "live"; token: TokenInfo } | { status: "missing" } {
    this.expireRecords(now);
    const index = this.records.findIndex((item) => item.id === id);
    const record = this.records[index];
    if (!record) return { status: "missing" };
    if (this.isLive(record, now)) return { status: "live", token: toInfo(record) };
    this.records.splice(index, 1);
    log.info("token.deleted", { tokenId: id, name: record.name });
    this.save();
    return { status: "removed", token: toInfo(record) };
  }

  /** Deletes every token that is over, revoked or expired. Live tokens are never touched. Returns the records removed. */
  prune(now = this.now()): TokenInfo[] {
    this.expireRecords(now);
    const removed: TokenInfo[] = [];
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record && !this.isLive(record, now)) {
        this.records.splice(i, 1);
        removed.unshift(toInfo(record));
      }
    }
    if (removed.length > 0) {
      log.info("token.pruned", { count: removed.length });
      this.save();
    }
    return removed;
  }

  /**
   * Calls `listener` once, when the token is revoked or expires. A token that is already over calls it straight away.
   * Returns a function that stops watching.
   */
  watch(id: string, listener: () => void, now = this.now()): () => void {
    const record = this.records.find((item) => item.id === id);
    if (!record || !this.isLive(record, now)) {
      listener();
      return () => {};
    }
    const set = this.watchers.get(id) ?? new Set<() => void>();
    set.add(listener);
    this.watchers.set(id, set);
    return () => {
      const current = this.watchers.get(id);
      current?.delete(listener);
      if (current?.size === 0) this.watchers.delete(id);
    };
  }

  /** Drops expired tokens and writes a pending last-used update. Returns how many tokens expired. */
  sweep(now = this.now()): number {
    const removed = this.expireRecords(now);
    if (removed > 0 || (this.dirty && now - this.lastSaveAt >= SAVE_INTERVAL_MS)) this.save();
    return removed;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.dirty) this.save();
  }

  private isLive(record: TokenRecord, now: number): boolean {
    if (record.revokedAt !== null) return false;
    return record.expiresAt === null || now < record.expiresAt;
  }

  private markUsed(record: TokenRecord, ip: string, now: number): void {
    const address = clean(ip, ADDRESS_MAX);
    const ipChanged = address !== "" && address !== record.lastUsedIp;
    record.lastUsedAt = now;
    if (ipChanged) record.lastUsedIp = address;
    this.dirty = true;
    if (ipChanged || now - this.lastSaveAt >= SAVE_INTERVAL_MS) this.save();
  }

  private consumeRate(record: TokenRecord, now: number): void {
    const limit = record.quotas.rateLimit;
    if (limit === null) return;
    const windowMs = (record.quotas.rateWindowSec ?? 60) * 1000;
    const hit = this.hits.get(record.id);
    if (!hit || now >= hit.start + windowMs) {
      this.hits.set(record.id, { start: now, count: 1 });
      return;
    }
    hit.count += 1;
    if (hit.count > limit) throw new AppError(429, "too_many_requests", msg("token_rate_limited"));
  }

  private expireRecords(now: number): number {
    // Only tokens still in the lookup map. An expired token stays in the file with `revokedAt` null, and ending it
    // again on every sweep would rewrite the file forever.
    const expired = this.records.filter(
      (record) => record.revokedAt === null && !this.isLive(record, now) && this.live.has(record.tokenHash),
    );
    for (const record of expired) this.end(record, now, false);
    if (expired.length > 0) this.dirty = true;
    return expired.length;
  }

  /** Drops the hash immediately. `revoked` sets revokedAt; expiry leaves it null so the two stay distinct. */
  private end(record: TokenRecord, now: number, revoked: boolean): void {
    this.live.delete(record.tokenHash);
    if (revoked) record.revokedAt = now;
    this.hits.delete(record.id);
    const listeners = this.watchers.get(record.id);
    this.watchers.delete(record.id);
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch (e) {
        log.warn("token.listener_failed", { tokenId: record.id, error: String(e) });
      }
    }
  }

  private restore(): void {
    let text: string;
    try {
      text = readFileSync(this.opts.file, "utf8");
    } catch (e) {
      if (!isNotFound(e)) log.warn("tokens.unreadable", { path: this.opts.file, reason: "read failed" });
      return;
    }
    const stored = parseStoredFile(text);
    if (!stored) {
      log.warn("tokens.unreadable", { path: this.opts.file, reason: "not a token file" });
      return;
    }
    const now = this.now();
    // Stored scopes are the owner's grants. A preset plus an explicit scope is indistinguishable from an older preset.
    this.records.push(...stored);
    for (const record of this.records) {
      if (this.isLive(record, now)) this.live.set(record.tokenHash, record);
    }
    this.dirty = this.live.size + this.records.filter((record) => !this.isLive(record, now)).length !== stored.length;
  }

  private save(): void {
    this.dirty = false;
    this.lastSaveAt = this.now();
    this.trimRevoked();
    const body = JSON.stringify({ version: FILE_VERSION, tokens: this.records.map(toStored) }, null, 2);
    try {
      writeFileAtomic(this.opts.file, `${body}\n`);
      this.saveFailing = false;
    } catch (e) {
      this.dirty = true;
      if (!this.saveFailing) {
        log.warn("tokens.persist_failed", {
          path: this.opts.file,
          error: String(e),
          hint: "Tokens are kept in memory only and end when MiniBox restarts.",
        });
      }
      this.saveFailing = true;
    }
  }

  /** Keeps the newest ended tokens and drops the rest, so a long-lived install does not grow the file without limit. */
  private trimRevoked(): void {
    const ended = this.records.filter((record) => !this.isLive(record, this.now()));
    if (ended.length <= MAX_TOKENS) return;
    const drop = new Set(ended.toSorted((a, b) => endedAt(a) - endedAt(b)).slice(0, ended.length - MAX_TOKENS));
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record && drop.has(record)) this.records.splice(i, 1);
    }
  }
}

function toPrincipal(record: TokenRecord): TokenPrincipal {
  const grants: TokenGrants = {
    ...(storageAdminPolicy(record) ? { storageAdmin: true } : {}),
    scopes: record.scopes,
    boxes: record.boxes,
    volumes: record.volumes,
    hosts: record.hosts,
    quotas: record.quotas,
    audit: record.audit,
  };
  return { type: "token", id: record.id, name: record.name, grants };
}

function toInfo(record: TokenRecord): TokenInfo {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    preset: record.preset,
    scopes: [...record.scopes],
    boxes: cloneBoxes(record.boxes),
    volumes: cloneVolumes(record.volumes),
    hosts: cloneHosts(record.hosts),
    quotas: { ...record.quotas },
    audit: record.audit,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
    lastUsedIp: record.lastUsedIp,
    createdBy: record.createdBy,
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
  };
}

function cloneBoxes(scope: BoxScope): BoxScope {
  if (scope.type === "ids") return { type: "ids", ids: [...scope.ids] };
  if (scope.type === "tags") return { type: "tags", tags: [...scope.tags] };
  return scope.type === "all" ? { type: "all" } : { type: "created-by-me" };
}

function cloneVolumes(scope: VolumeScope): VolumeScope {
  return scope.type === "all" ? { type: "all" } : { type: "list", ids: [...scope.ids] };
}

function cloneHosts(scope: HostScope): HostScope {
  return scope.type === "all" ? { type: "all" } : { type: "list", ids: [...scope.ids] };
}

function clean(value: string, max: number): string {
  return [...value.replace(/\p{Cc}/gu, " ").trim()].slice(0, max).join("");
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function parseStoredFile(text: string): TokenRecord[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.version !== FILE_VERSION || !Array.isArray(data.tokens)) return null;
  const records: TokenRecord[] = [];
  for (const entry of data.tokens) {
    const record = parseRecord(entry);
    if (record) records.push(record);
  }
  return records;
}

function parseRecord(value: unknown): TokenRecord | null {
  if (!isObject(value)) return null;
  const { id, name, tokenHash, prefix, preset, scopes, createdBy } = value;
  if (typeof id !== "string" || !TOKEN_ID.test(id)) return null;
  if (typeof name !== "string" || name === "") return null;
  if (typeof tokenHash !== "string" || !SHA256_HEX.test(tokenHash)) return null;
  if (typeof prefix !== "string" || prefix === "") return null;
  let presetName: PresetName | null = null;
  if (preset !== null) {
    if (typeof preset !== "string" || !isPreset(preset)) return null;
    presetName = preset;
  }
  if (!Array.isArray(scopes)) return null;
  const parsedScopes: Scope[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "string" || !isScope(scope)) return null;
    parsedScopes.push(scope);
  }
  const boxes = parseBoxes(value.boxes);
  const volumes = parseVolumes(value.volumes);
  const hosts = parseHosts(value.hosts);
  const quotas = parseQuotas(value.quotas);
  if (!boxes || !volumes || !hosts || !quotas) return null;
  const createdAt = parseTime(value.createdAt);
  const expiresAt = parseOptionalTime(value.expiresAt);
  const lastUsedAt = parseOptionalTime(value.lastUsedAt);
  const revokedAt = parseOptionalTime(value.revokedAt);
  if (createdAt === null || expiresAt === undefined || lastUsedAt === undefined || revokedAt === undefined) return null;
  if (value.audit !== "all" && value.audit !== "scoped") return null;
  if (typeof createdBy !== "string" || createdBy === "") return null;
  const ip =
    value.lastUsedIp === null
      ? null
      : typeof value.lastUsedIp === "string"
        ? clean(value.lastUsedIp, ADDRESS_MAX)
        : null;
  if (value.lastUsedIp !== null && ip === null) return null;
  return {
    id,
    name,
    tokenHash,
    prefix,
    preset: presetName,
    scopes: parsedScopes,
    boxes,
    volumes,
    hosts,
    quotas,
    audit: value.audit,
    createdAt,
    expiresAt,
    lastUsedAt,
    lastUsedIp: ip,
    createdBy,
    revokedAt,
  };
}

function parseBoxes(value: unknown): BoxScope | null {
  if (!isObject(value)) return null;
  if (value.type === "created-by-me") return { type: "created-by-me" };
  if (value.type === "all") return { type: "all" };
  if (value.type === "ids" && Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string")) {
    return { type: "ids", ids: value.ids };
  }
  if (value.type === "tags" && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")) {
    return { type: "tags", tags: value.tags };
  }
  return null;
}

function parseVolumes(value: unknown): VolumeScope | null {
  if (!isObject(value)) return null;
  if (value.type === "all") return { type: "all" };
  if (value.type === "list" && Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string")) {
    return { type: "list", ids: value.ids };
  }
  return null;
}

function parseHosts(value: unknown): HostScope | null {
  if (!isObject(value)) return null;
  if (value.type === "all") return { type: "all" };
  if (value.type === "list" && Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string")) {
    return { type: "list", ids: value.ids };
  }
  return null;
}

/** Quotas that tokens stored before they existed lack. A record without one has no limit for it, and stays valid. */
const ADDED_LATER: readonly (keyof Quotas)[] = ["maxCheckpoints"];

function parseQuotas(value: unknown): Quotas | null {
  if (!isObject(value)) return null;
  const keys = [
    "maxBoxes",
    "maxCpus",
    "maxMemoryMb",
    "maxTtlSec",
    "rateLimit",
    "rateWindowSec",
    "maxCheckpoints",
  ] as const;
  const quotas: { -readonly [K in keyof Quotas]: number | null } = { ...NO_QUOTA };
  for (const key of keys) {
    const item = value[key];
    if (item === null || (item === undefined && ADDED_LATER.includes(key))) continue;
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    quotas[key] = item;
  }
  return quotas;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Null stays null. A missing or invalid value is `undefined`, which drops the record. */
function parseOptionalTime(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return parseTime(value);
}

function endedAt(record: TokenRecord): number {
  return record.revokedAt ?? record.expiresAt ?? record.createdAt;
}

function toStored(record: TokenRecord) {
  return {
    id: record.id,
    name: record.name,
    tokenHash: record.tokenHash,
    prefix: record.prefix,
    preset: record.preset,
    scopes: record.scopes,
    boxes: record.boxes,
    volumes: record.volumes,
    hosts: record.hosts,
    quotas: record.quotas,
    audit: record.audit,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
    lastUsedIp: record.lastUsedIp,
    createdBy: record.createdBy,
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
