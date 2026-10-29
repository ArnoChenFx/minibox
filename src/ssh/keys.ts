import { createHash, randomBytes } from "node:crypto";

import { utils, type ParsedKey } from "ssh2";

import { readSecretFile, sshKeysPath, writeFileAtomic } from "../data-dir";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";

/** How many keys the owner may add. Each login tries them one by one, so the list stays short. */
export const SSH_KEYS_MAX = 50;
export const SSH_KEY_LABEL_MAX = 64;
/** Longer than any RSA 16384 public key line, short enough that a pasted file is refused. */
export const SSH_KEY_TEXT_MAX = 16_384;
/** lastUsedAt is written at most this often for one key, so a busy key does not rewrite the file on every login. */
const TOUCH_INTERVAL_MS = 60_000;

/** The key types a login may use. DSA is broken and ssh2 cannot verify security-key types. */
const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
] as const;

/** What the API returns for a key. */
export interface SshKeyInfo {
  readonly id: string;
  readonly label: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  /** The key in authorized_keys form, without its comment. */
  readonly publicKey: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

type SshKeyRecord = { -readonly [K in keyof SshKeyInfo]: SshKeyInfo[K] };

/** The OpenSSH fingerprint of a public key blob: `SHA256:` and unpadded base64. */
function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** A pasted authorized_keys line, checked. The comment becomes the default label. */
export interface ParsedPublicKey {
  readonly algorithm: string;
  readonly blob: Buffer;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly comment: string;
}

/** Parses one public key line. Options before the type, as authorized_keys allows, are refused: a key here has none. */
export function parsePublicKey(text: string): ParsedPublicKey {
  const line = text.trim();
  if (line.includes("PRIVATE KEY")) throw new AppError(400, "bad_request", msg("ssh_key_private"));
  if (line === "" || line.length > SSH_KEY_TEXT_MAX || /[\r\n]/.test(line)) {
    throw new AppError(400, "bad_request", msg("ssh_key_invalid"));
  }
  const [type = "", data = "", ...rest] = line.split(/\s+/);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError(400, "bad_request", msg("ssh_key_invalid"));
  const parsed = utils.parseKey(`${type} ${data}`);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new AppError(400, "bad_request", msg("ssh_key_invalid"));
  const key = parsed as ParsedKey;
  if (key.isPrivateKey()) throw new AppError(400, "bad_request", msg("ssh_key_private"));
  if (!(SSH_KEY_TYPES as readonly string[]).includes(key.type)) {
    throw new AppError(400, "bad_request", msg("ssh_key_type", { type: key.type }));
  }
  const blob = key.getPublicSSH();
  return {
    algorithm: key.type,
    blob,
    fingerprint: sshFingerprint(blob),
    publicKey: `${key.type} ${blob.toString("base64")}`,
    comment: rest.join(" ").slice(0, SSH_KEY_LABEL_MAX),
  };
}

function isRecord(value: unknown): value is SshKeyRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<SshKeyRecord>;
  return (
    typeof r.id === "string" &&
    typeof r.label === "string" &&
    typeof r.publicKey === "string" &&
    typeof r.createdAt === "number" &&
    (r.lastUsedAt === null || typeof r.lastUsedAt === "number")
  );
}

/**
 * The owner's SSH public keys, which log in to every box over direct SSH. `DATA_DIR/ssh_keys.json`, mode 600. Public
 * keys are not secret, but the file decides who gets a shell, so it is kept like the token file.
 */
export class SshKeyStore {
  private records: SshKeyRecord[] = [];
  /** fingerprint → record, and the parsed key used to verify signatures. */
  private readonly byFingerprint = new Map<string, { record: SshKeyRecord; key: ParsedKey }>();
  private readonly touchedAt = new Map<string, number>();

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.restore();
  }

  private path(): string {
    return sshKeysPath(this.dataDir);
  }

  private restore(): void {
    const text = readSecretFile(this.path());
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      log.error("ssh_keys.unreadable", { error: String(e) });
      throw new Error(`${this.path()} is not valid JSON. Fix or remove it, then restart.`, { cause: e });
    }
    const list = Array.isArray((raw as { keys?: unknown })?.keys) ? (raw as { keys: unknown[] }).keys : [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      try {
        const parsed = parsePublicKey(item.publicKey);
        this.index({ ...item, algorithm: parsed.algorithm, fingerprint: parsed.fingerprint });
      } catch {
        log.warn("ssh_keys.skipped", { id: item.id });
      }
    }
  }

  private index(record: SshKeyRecord): void {
    const key = utils.parseKey(record.publicKey) as ParsedKey;
    this.records.push(record);
    this.byFingerprint.set(record.fingerprint, { record, key });
  }

  private save(): void {
    writeFileAtomic(this.path(), `${JSON.stringify({ keys: this.records }, null, 2)}\n`);
  }

  list(): SshKeyInfo[] {
    return this.records.map((r) => ({ ...r }));
  }

  get size(): number {
    return this.records.length;
  }

  add(text: string, label?: string): SshKeyInfo {
    const parsed = parsePublicKey(text);
    const taken = this.byFingerprint.get(parsed.fingerprint);
    if (taken) throw new AppError(409, "conflict", msg("ssh_key_taken", { label: taken.record.label }));
    if (this.records.length >= SSH_KEYS_MAX)
      throw new AppError(409, "conflict", msg("ssh_key_limit", { max: SSH_KEYS_MAX }));
    const record: SshKeyRecord = {
      id: `sk_${randomBytes(8).toString("hex")}`,
      label: label?.trim() || parsed.comment || parsed.algorithm,
      algorithm: parsed.algorithm,
      fingerprint: parsed.fingerprint,
      publicKey: parsed.publicKey,
      createdAt: this.now(),
      lastUsedAt: null,
    };
    this.index(record);
    try {
      this.save();
    } catch (e) {
      this.drop(record.id);
      throw e;
    }
    return { ...record };
  }

  remove(id: string): SshKeyInfo {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new AppError(404, "not_found", msg("ssh_key_not_found"));
    this.drop(id);
    try {
      this.save();
    } catch (e) {
      this.index(record);
      throw e;
    }
    return { ...record };
  }

  private drop(id: string): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    this.records = this.records.filter((r) => r.id !== id);
    this.byFingerprint.delete(record.fingerprint);
    this.touchedAt.delete(id);
  }

  /** The registered key with this public blob and algorithm, if any. Used to answer a client's key query. */
  find(algorithm: string, blob: Buffer): SshKeyInfo | null {
    const hit = this.byFingerprint.get(sshFingerprint(blob));
    if (!hit) return null;
    if (!sameKeyType(hit.record.algorithm, algorithm)) return null;
    return hit.record;
  }

  /**
   * Checks a publickey signature against a registered key. `hashAlgo` is the hash an RSA client signed with
   * (rsa-sha2-256 or rsa-sha2-512), which ssh2 passes through. Returns the key that verified, or null.
   */
  verify(algorithm: string, blob: Buffer, data: Buffer, signature: Buffer, hashAlgo?: string): SshKeyInfo | null {
    const hit = this.byFingerprint.get(sshFingerprint(blob));
    if (!hit || !sameKeyType(hit.record.algorithm, algorithm)) return null;
    let ok = false;
    try {
      ok = hit.key.verify(data, signature, hashAlgo) === true;
    } catch {
      ok = false;
    }
    return ok ? hit.record : null;
  }

  /** Records a login with the key. Written at most once a minute per key, and a failed write only logs. */
  touch(id: string): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    const now = this.now();
    record.lastUsedAt = now;
    const last = this.touchedAt.get(id) ?? 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    this.touchedAt.set(id, now);
    try {
      this.save();
    } catch (e) {
      log.warn("ssh_keys.save_failed", { error: String(e) });
    }
  }
}

/** An RSA key signs as ssh-rsa, rsa-sha2-256 or rsa-sha2-512; every other type names itself. */
function sameKeyType(stored: string, offered: string): boolean {
  if (stored === offered) return true;
  return stored === "ssh-rsa" && (offered === "rsa-sha2-256" || offered === "rsa-sha2-512");
}
