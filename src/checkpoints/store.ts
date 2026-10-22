import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DIR_MODE, ensureDataDir, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import { isBoxId } from "../specs/revision";
import { isCheckpointId, newCheckpointId } from "./id";
import { CHECKPOINT_VERSION, type CheckpointRecord, type PendingRollback, ROLLBACK_VERSION } from "./types";

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

function isPendingRollback(value: unknown): value is PendingRollback {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Partial<PendingRollback>;
  return (
    pending.version === ROLLBACK_VERSION &&
    typeof pending.boxId === "string" &&
    isBoxId(pending.boxId) &&
    typeof pending.hostId === "string" &&
    typeof pending.checkpointId === "string" &&
    isCheckpointId(pending.checkpointId) &&
    typeof pending.safetyCheckpointId === "string" &&
    isCheckpointId(pending.safetyCheckpointId) &&
    Array.isArray(pending.replaced) &&
    Array.isArray(pending.restored)
  );
}

function isRecord(value: unknown): value is CheckpointRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CheckpointRecord>;
  return (
    record.version === CHECKPOINT_VERSION &&
    typeof record.id === "string" &&
    isCheckpointId(record.id) &&
    typeof record.hostId === "string" &&
    typeof record.boxId === "string" &&
    typeof record.pinned === "boolean" &&
    typeof record.spec === "object" &&
    record.spec !== null &&
    Array.isArray(record.data)
  );
}

/**
 * `DATA_DIR/checkpoints/<id>.json`, one file per checkpoint, shared by every host like the volume records. Writes are
 * atomic and mode 600. Reads go to disk: checkpoints are few, and they are read for listings and mutations only.
 */
export class CheckpointStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  dir(): string {
    return join(this.dataDir, "checkpoints");
  }

  pathFor(id: string): string {
    if (!isCheckpointId(id)) throw new Error(`refusing a checkpoint path for ${id}`);
    return join(this.dir(), `${id}.json`);
  }

  /** `DATA_DIR/checkpoints/rollbacks`: one file per box whose rollback still waits for a confirm or an undo. */
  rollbackDir(): string {
    return join(this.dir(), "rollbacks");
  }

  pendingRollback(boxId: string): PendingRollback | null {
    if (!isBoxId(boxId)) return null;
    return this.readPending(boxId);
  }

  pendingRollbacks(): PendingRollback[] {
    let names: string[];
    try {
      names = readdirSync(this.rollbackDir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    const pending: PendingRollback[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const boxId = name.slice(0, -".json".length);
      if (!isBoxId(boxId)) continue;
      const record = this.readPending(boxId);
      if (record) pending.push(record);
    }
    return pending;
  }

  writePendingRollback(record: PendingRollback): void {
    ensureDataDir(this.dataDir);
    mkdirSync(this.rollbackDir(), { recursive: true, mode: DIR_MODE });
    writeFileAtomic(this.pendingPath(record.boxId), `${JSON.stringify(record, null, 2)}\n`);
  }

  removePendingRollback(boxId: string): void {
    if (!isBoxId(boxId)) return;
    try {
      unlinkSync(this.pendingPath(boxId));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  /**
   * Runs `fn` only after every earlier mutation has finished. Not re-entrant: a function inside the lock must not call
   * `exclusive` again.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  allocateId(): string {
    let id = newCheckpointId();
    for (let attempt = 0; attempt < 5 && this.read(id); attempt++) id = newCheckpointId();
    if (this.read(id)) throw new Error("could not allocate a checkpoint id");
    return id;
  }

  list(): CheckpointRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    const records: CheckpointRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isCheckpointId(id)) continue;
      const record = this.readJson(id);
      if (record) records.push(record);
    }
    return records;
  }

  read(id: string): CheckpointRecord | null {
    if (!isCheckpointId(id)) return null;
    return this.readJson(id);
  }

  write(record: CheckpointRecord): void {
    ensureDataDir(this.dataDir);
    writeFileAtomic(this.pathFor(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  remove(id: string): void {
    if (!isCheckpointId(id)) return;
    try {
      unlinkSync(this.pathFor(id));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  private pendingPath(boxId: string): string {
    if (!isBoxId(boxId)) throw new Error(`refusing a rollback path for ${boxId}`);
    return join(this.rollbackDir(), `${boxId}.json`);
  }

  /** A corrupt file is left in place and skipped, so the box reads as having no rollback waiting. Nothing is deleted. */
  private readPending(boxId: string): PendingRollback | null {
    let text: string;
    try {
      text = readFileSync(this.pendingPath(boxId), "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isPendingRollback(parsed) && parsed.boxId === boxId) return parsed;
      log.warn("checkpoint.rollback_unreadable", { box: boxId, error: "not a rollback record" });
      return null;
    } catch (e) {
      log.warn("checkpoint.rollback_unreadable", { box: boxId, error: String(e) });
      return null;
    }
  }

  /** A corrupt file is left in place and skipped, as the volume records are. */
  private readJson(id: string): CheckpointRecord | null {
    let text: string;
    try {
      text = readFileSync(this.pathFor(id), "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) {
        log.warn("checkpoint.unreadable", { id, error: "not a checkpoint record" });
        return null;
      }
      return parsed;
    } catch (e) {
      log.warn("checkpoint.unreadable", { id, error: String(e) });
      return null;
    }
  }
}
