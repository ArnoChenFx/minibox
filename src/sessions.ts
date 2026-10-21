import { createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./data-dir";
import { log } from "./lib/logger";

/** Most sessions kept at once. A sign-in beyond this ends the least recently used session. */
export const MAX_SESSIONS = 100;
/** Expired sessions end, and their open terminals close, within this long of expiry. */
const SWEEP_MS = 10_000;
/** `lastSeenAt` changes on every request, so it reaches disk at most this often. */
const SAVE_INTERVAL_MS = 60_000;
const FILE_VERSION = 1;
const TOKEN_BYTES = 32;
const FINGERPRINT_SALT = "minibox.sessions.key-fingerprint.v1";
const USER_AGENT_MAX = 256;
const ADDRESS_MAX = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ID_HEX = /^[0-9a-f]{32}$/;

/** A session as stored. The token itself is never kept, only its SHA-256 hash. */
export interface SessionRecord {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string;
  ip: string;
}

/** A session as reported to callers, without anything that could be used to match a token. */
export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string;
  ip: string;
}

export interface SessionStoreOptions {
  /** Path of the session file, normally `DATA_DIR/sessions.json`. */
  file: string;
  /** The access key this process runs with. Only a scrypt fingerprint of it is written, to detect a change. */
  accessKey: string;
  /** Absolute lifetime of a session, counted from sign-in. */
  ttlMs: number;
  /** Sliding renewal: a session also ends this long after its last use. `null` turns renewal off. */
  idleMs: number | null;
  now?: () => number;
}

/**
 * Browser sessions. Each sign-in gets a random token: the cookie carries it, and the file keeps only its hash, so a
 * copy of DATA_DIR cannot be turned into a login. Sessions end when revoked, when they expire, when the access key
 * changes, or when the store is over MAX_SESSIONS.
 */
export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly keyFingerprint: string;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private lastSaveAt = 0;
  private saveFailing = false;

  constructor(private readonly opts: SessionStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.keyFingerprint = fingerprintKey(opts.accessKey);
    this.restore();
    if (this.dirty) this.save();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  /** Starts a session for a successful sign-in. The returned token belongs in the cookie and is not kept. */
  create(meta: { userAgent: string; ip: string }, now = this.now()): { token: string; session: SessionInfo } {
    this.expireRecords(now);
    while (this.records.size >= MAX_SESSIONS) {
      const oldest = this.leastRecentlyUsed();
      if (!oldest) break;
      this.end(oldest);
      log.info("session.evicted", { sessionId: oldest.id });
    }
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const record: SessionRecord = {
      id: randomBytes(16).toString("hex"),
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + this.opts.ttlMs,
      lastSeenAt: now,
      userAgent: clean(meta.userAgent, USER_AGENT_MAX),
      ip: clean(meta.ip, ADDRESS_MAX),
    };
    this.records.set(record.tokenHash, record);
    this.save();
    return { token, session: toInfo(record) };
  }

  /** The live session behind a token. The request counts as use, which renews the session when sliding renewal is on. */
  touch(token: string, now = this.now()): SessionInfo | null {
    return this.markUsed(this.records.get(hashToken(token)) ?? null, now);
  }

  /** Records activity on a live session by id, such as input on an open terminal. */
  touchId(id: string, now = this.now()): SessionInfo | null {
    return this.markUsed(this.byId(id), now);
  }

  /** Live sessions, most recently used first. */
  list(now = this.now()): SessionInfo[] {
    return [...this.records.values()]
      .filter((record) => this.isLive(record, now))
      .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(toInfo);
  }

  /** Ends one session. Returns `false` when no session has that id. */
  revoke(id: string, reason: string): boolean {
    const record = this.byId(id);
    if (!record) return false;
    this.end(record);
    log.info("session.revoked", { sessionId: id, reason });
    this.save();
    return true;
  }

  /** Ends every live session except `keepId`. Returns how many were ended. */
  revokeOthers(keepId: string | null): number {
    const now = this.now();
    const others = [...this.records.values()].filter((record) => record.id !== keepId && this.isLive(record, now));
    for (const record of others) this.end(record);
    if (others.length > 0) {
      log.info("session.revoked", { count: others.length, reason: "sign_out_others" });
      this.save();
    }
    return others.length;
  }

  /**
   * Calls `listener` once, when the session ends by revocation, eviction or expiry. A session that is already over
   * calls it straight away. Returns a function that stops watching.
   */
  watch(id: string, listener: () => void): () => void {
    if (!this.liveById(id, this.now())) {
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

  /** Drops expired sessions and writes pending `lastSeenAt` updates. Returns how many sessions were dropped. */
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

  private markUsed(record: SessionRecord | null, now: number): SessionInfo | null {
    if (!record || !this.isLive(record, now)) return null;
    record.lastSeenAt = now;
    this.markDirty(now);
    return toInfo(record);
  }

  private isLive(record: SessionRecord, now: number): boolean {
    if (now >= record.expiresAt) return false;
    return this.opts.idleMs === null || now < record.lastSeenAt + this.opts.idleMs;
  }

  private byId(id: string): SessionRecord | null {
    for (const record of this.records.values()) if (record.id === id) return record;
    return null;
  }

  private liveById(id: string, now: number): SessionRecord | null {
    const record = this.byId(id);
    return record && this.isLive(record, now) ? record : null;
  }

  private leastRecentlyUsed(): SessionRecord | null {
    let oldest: SessionRecord | null = null;
    for (const record of this.records.values()) {
      if (!oldest || record.lastSeenAt < oldest.lastSeenAt) oldest = record;
    }
    return oldest;
  }

  /** Drops sessions that are no longer live, without writing. Returns how many were dropped. */
  private expireRecords(now: number): number {
    const expired = [...this.records.values()].filter((record) => !this.isLive(record, now));
    for (const record of expired) this.end(record);
    return expired.length;
  }

  private end(record: SessionRecord): void {
    this.records.delete(record.tokenHash);
    const listeners = this.watchers.get(record.id);
    this.watchers.delete(record.id);
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch (e) {
        log.warn("session.listener_failed", { sessionId: record.id, error: String(e) });
      }
    }
  }

  private markDirty(now: number): void {
    this.dirty = true;
    if (now - this.lastSaveAt >= SAVE_INTERVAL_MS) this.save();
  }

  /**
   * Loads the file, keeping live sessions. A file written under a different access key is discarded whole,
   * which is what ends every session when ACCESS_KEY changes. An unreadable file starts the store empty.
   */
  private restore(): void {
    let text: string;
    try {
      text = readFileSync(this.opts.file, "utf8");
    } catch (e) {
      if (!isNotFound(e)) log.warn("sessions.unreadable", { path: this.opts.file, reason: "read failed" });
      return;
    }
    const stored = parseStoredFile(text);
    if (!stored) {
      log.warn("sessions.unreadable", { path: this.opts.file, reason: "not a session file" });
      return;
    }
    if (stored.keyFingerprint !== this.keyFingerprint) {
      log.info("sessions.key_changed", { revoked: stored.sessions.length });
      this.dirty = true;
      return;
    }
    const now = this.now();
    for (const record of stored.sessions) {
      if (this.isLive(record, now)) this.records.set(record.tokenHash, record);
    }
    this.dirty = this.records.size !== stored.sessions.length || stored.dropped > 0;
  }

  private save(): void {
    this.dirty = false;
    this.lastSaveAt = this.now();
    const body = JSON.stringify(
      {
        version: FILE_VERSION,
        keyFingerprint: this.keyFingerprint,
        sessions: [...this.records.values()].map(toStored),
      },
      null,
      2,
    );
    try {
      writeFileAtomic(this.opts.file, `${body}\n`);
      this.saveFailing = false;
    } catch (e) {
      this.dirty = true;
      if (!this.saveFailing) {
        log.warn("sessions.persist_failed", {
          path: this.opts.file,
          error: String(e),
          hint: "Sessions are kept in memory only and end when MiniBox restarts.",
        });
      }
      this.saveFailing = true;
    }
  }
}

function fingerprintKey(accessKey: string): string {
  return scryptSync(accessKey, FINGERPRINT_SALT, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Strips control characters and caps the length. User-Agent and address come from the client and are shown back to it. */
function clean(value: string, max: number): string {
  return [...value.replace(/\p{Cc}/gu, " ").trim()].slice(0, max).join("");
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function toInfo(record: SessionRecord): SessionInfo {
  return {
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
    userAgent: record.userAgent,
    ip: record.ip,
  };
}

interface StoredFile {
  keyFingerprint: string;
  sessions: SessionRecord[];
  /** Entries that failed validation and were skipped. */
  dropped: number;
}

function parseStoredFile(text: string): StoredFile | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.version !== FILE_VERSION) return null;
  if (typeof data.keyFingerprint !== "string" || !Array.isArray(data.sessions)) return null;
  const sessions: SessionRecord[] = [];
  for (const entry of data.sessions) {
    const record = parseRecord(entry);
    if (record) sessions.push(record);
  }
  return { keyFingerprint: data.keyFingerprint, sessions, dropped: data.sessions.length - sessions.length };
}

function parseRecord(value: unknown): SessionRecord | null {
  if (!isObject(value)) return null;
  const { id, tokenHash, createdAt, expiresAt, lastSeenAt, userAgent, ip } = value;
  if (typeof id !== "string" || !ID_HEX.test(id)) return null;
  if (typeof tokenHash !== "string" || !SHA256_HEX.test(tokenHash)) return null;
  if (typeof userAgent !== "string" || typeof ip !== "string") return null;
  const created = parseTime(createdAt);
  const expires = parseTime(expiresAt);
  const seen = parseTime(lastSeenAt);
  if (created === null || expires === null || seen === null) return null;
  return {
    id,
    tokenHash,
    createdAt: created,
    expiresAt: expires,
    lastSeenAt: seen,
    userAgent: clean(userAgent, USER_AGENT_MAX),
    ip: clean(ip, ADDRESS_MAX),
  };
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toStored(record: SessionRecord) {
  return {
    id: record.id,
    tokenHash: record.tokenHash,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    userAgent: record.userAgent,
    ip: record.ip,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
