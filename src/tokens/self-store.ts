import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../data-dir";
import { AppError } from "../lib/errors";
import { sha256 } from "../lib/hash";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { BoxSelfPrincipal } from "../operations/types";
import { isBoxId } from "../specs/revision";
import { SELF_QUOTA } from "./self-policy";

const FILE_VERSION = 1;
const SECRET_BYTES = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface SelfRecord {
  readonly boxId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly issuedAt: string;
}

export interface SelfTokenStoreOptions {
  /** Path of the file, normally `DATA_DIR/self-tokens.json`. */
  readonly file: string;
  readonly now?: () => number;
}

/**
 * The self tokens of boxes. A box has at most one: issuing replaces it, and revoking removes it. The file keeps only the
 * SHA-256 hash, so a running box's token keeps working across a MiniBox restart without the secret ever being written.
 * Watchers hear a token end the moment it is replaced or revoked, so the sessions it opened end with it.
 */
export class SelfTokenStore {
  private readonly byBox = new Map<string, SelfRecord>();
  private readonly byHash = new Map<string, SelfRecord>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: SelfTokenStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.restore();
  }

  /** Issues the box's token and returns its secret. The secret is the only copy: the store keeps its hash. */
  issue(boxId: string, name: string): string {
    const secret = `mbx_${randomBytes(SECRET_BYTES).toString("base64url")}`;
    this.drop(boxId);
    const record: SelfRecord = {
      boxId,
      name,
      tokenHash: sha256(secret),
      issuedAt: new Date(this.now()).toISOString(),
    };
    this.byBox.set(boxId, record);
    this.byHash.set(record.tokenHash, record);
    this.save();
    log.info("box.self_token_issued", { boxId });
    return secret;
  }

  has(boxId: string): boolean {
    return this.byBox.has(boxId);
  }

  /**
   * Gives the box's record its new name, so the events its agent writes carry the box's current name. The spec is already
   * renamed when this runs, so a record that cannot be saved is logged rather than failing a rename that has happened.
   */
  rename(boxId: string, name: string): void {
    const record = this.byBox.get(boxId);
    if (!record || record.name === name) return;
    const renamed: SelfRecord = { ...record, name };
    this.byBox.set(boxId, renamed);
    this.byHash.set(renamed.tokenHash, renamed);
    try {
      this.save();
    } catch (e) {
      log.warn("box.self_token_rename_unsaved", { boxId, error: String(e) });
    }
  }

  /** Ends the box's token. Returns false when the box had none. */
  revoke(boxId: string): boolean {
    if (!this.drop(boxId)) return false;
    this.save();
    log.info("box.self_token_revoked", { boxId });
    return true;
  }

  /** The principal for a self token's secret, or null when no box holds it. A token past its rate limit throws 429. */
  authenticate(secret: string, now = this.now()): BoxSelfPrincipal | null {
    if (secret === "") return null;
    const record = this.byHash.get(sha256(secret));
    if (!record) return null;
    this.consumeRate(record, now);
    return { type: "box-self", id: record.boxId, name: record.name };
  }

  /** Calls `listener` once when the box's token ends. A box with no token calls it straight away. Returns the stop. */
  watch(boxId: string, listener: () => void): () => void {
    if (!this.byBox.has(boxId)) {
      listener();
      return () => {};
    }
    const set = this.watchers.get(boxId) ?? new Set<() => void>();
    set.add(listener);
    this.watchers.set(boxId, set);
    return () => {
      const current = this.watchers.get(boxId);
      current?.delete(listener);
      if (current?.size === 0) this.watchers.delete(boxId);
    };
  }

  /** Removes the box's record from the lookup maps and tells its watchers. Returns false when there was none. */
  private drop(boxId: string): boolean {
    const record = this.byBox.get(boxId);
    if (!record) return false;
    this.byBox.delete(boxId);
    this.byHash.delete(record.tokenHash);
    this.hits.delete(boxId);
    const listeners = this.watchers.get(boxId);
    this.watchers.delete(boxId);
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch (e) {
        log.warn("box.self_token_listener_failed", { boxId, error: String(e) });
      }
    }
    return true;
  }

  private consumeRate(record: SelfRecord, now: number): void {
    const limit = SELF_QUOTA.rateLimit;
    if (limit === null) return;
    const windowMs = (SELF_QUOTA.rateWindowSec ?? 60) * 1000;
    const hit = this.hits.get(record.boxId);
    if (!hit || now >= hit.start + windowMs) {
      this.hits.set(record.boxId, { start: now, count: 1 });
      return;
    }
    hit.count += 1;
    if (hit.count > limit) throw new AppError(429, "too_many_requests", msg("token_rate_limited"));
  }

  private restore(): void {
    let text: string;
    try {
      text = readFileSync(this.opts.file, "utf8");
    } catch (e) {
      if (!isNotFound(e)) log.warn("box.self_tokens_unreadable", { path: this.opts.file, reason: "read failed" });
      return;
    }
    const records = parseStoredFile(text);
    if (!records) {
      log.warn("box.self_tokens_unreadable", { path: this.opts.file, reason: "not a self token file" });
      return;
    }
    for (const record of records) {
      if (this.byBox.has(record.boxId)) continue;
      this.byBox.set(record.boxId, record);
      this.byHash.set(record.tokenHash, record);
    }
  }

  private save(): void {
    const body = JSON.stringify({ version: FILE_VERSION, tokens: [...this.byBox.values()] }, null, 2);
    writeFileAtomic(this.opts.file, `${body}\n`);
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function parseStoredFile(text: string): SelfRecord[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.version !== FILE_VERSION || !Array.isArray(data.tokens)) return null;
  const records: SelfRecord[] = [];
  for (const entry of data.tokens) {
    if (!isObject(entry)) continue;
    const { boxId, name, tokenHash, issuedAt } = entry;
    if (typeof boxId !== "string" || !isBoxId(boxId)) continue;
    if (typeof name !== "string" || name === "") continue;
    if (typeof tokenHash !== "string" || !SHA256_HEX.test(tokenHash)) continue;
    if (typeof issuedAt !== "string") continue;
    records.push({ boxId, name, tokenHash, issuedAt });
  }
  return records;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
