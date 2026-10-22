import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DIR_MODE, ensureDataDir, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import { IDENT_RE } from "../lib/validation";

/** What the API and the console see of a secret. The value is never part of it. */
export interface SecretMeta {
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The file body. The name is the file name, so it is not repeated inside. */
interface SecretRecord {
  readonly value: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

function isRecord(value: unknown): value is SecretRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<SecretRecord>;
  return (
    typeof record.value === "string" && typeof record.createdAt === "string" && typeof record.updatedAt === "string"
  );
}

/**
 * Secrets that box environment variables reference: `DATA_DIR/secrets/env/<name>`, one JSON file per secret with mode
 * 600. A value is read only to put it into a container. The API, the event log and the logs carry names, never values.
 * Writes are atomic, so a reader sees the old value or the new one. `area` names another store under `secrets/`, such
 * as `notify` for channel secrets, which keep the same format.
 */
export class SecretStore {
  constructor(
    private readonly dataDir: string,
    private readonly area = "env",
  ) {}

  dir(): string {
    return join(this.dataDir, "secrets", this.area);
  }

  /** Every stored secret, sorted by name. A file whose name is not a valid secret name is not a secret, and is skipped. */
  list(): SecretMeta[] {
    let names: string[];
    try {
      names = readdirSync(this.dir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    return names
      .filter((name) => IDENT_RE.test(name))
      .toSorted()
      .flatMap((name) => {
        const meta = this.meta(name);
        return meta ? [meta] : [];
      });
  }

  /** `null` when the secret is missing or its file cannot be read. */
  meta(name: string): SecretMeta | null {
    const record = this.read(name);
    if (!record) return null;
    return { name, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  /** The stored value, or `null` when the secret is missing or unreadable. Only a container's env is built from it. */
  value(name: string): string | null {
    return this.read(name)?.value ?? null;
  }

  /** Creates the secret or replaces its value. `created` is false when the name already held a value. */
  set(name: string, value: string, now: string): { meta: SecretMeta; created: boolean } {
    const path = this.pathFor(name);
    const previous = this.read(name);
    ensureDataDir(this.dataDir);
    mkdirSync(this.dir(), { recursive: true, mode: DIR_MODE });
    const record: SecretRecord = { value, createdAt: previous?.createdAt ?? now, updatedAt: now };
    writeFileAtomic(path, `${JSON.stringify(record)}\n`, SECRET_FILE_MODE);
    return { meta: { name, createdAt: record.createdAt, updatedAt: now }, created: previous === null };
  }

  /** Removes the secret. Returns false when there was none. The caller checks that no box still references it. */
  remove(name: string): boolean {
    try {
      unlinkSync(this.pathFor(name));
      return true;
    } catch (e) {
      if (isEnoent(e)) return false;
      throw e;
    }
  }

  private pathFor(name: string): string {
    if (!IDENT_RE.test(name)) throw new Error(`refusing a secret path for ${name}`);
    return join(this.dir(), name);
  }

  private read(name: string): SecretRecord | null {
    if (!IDENT_RE.test(name)) return null;
    const text = readSecretFile(this.pathFor(name));
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      log.warn("secret.unreadable", { name, error: "not JSON" });
      return null;
    }
    if (!isRecord(parsed)) {
      log.warn("secret.unreadable", { name, error: "not a secret record" });
      return null;
    }
    return parsed;
  }
}
