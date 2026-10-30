import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DIR_MODE, ensureDataDir, writeFileAtomic } from "../data-dir";
import { hostGone } from "../host/gone";
import { log } from "../lib/logger";
import { isBoxId } from "../specs/revision";
import { isCheckpointId, newCheckpointId } from "./id";
import { PackageStore } from "./packages";
import { type BoxSchedule, BoxScheduleSchema } from "./schedule";
import {
  CHECKPOINT_VERSION,
  type CheckpointRecord,
  type PendingRollback,
  type RolledVolume,
  ROLLBACK_VERSION,
} from "./types";

const DEFAULT_PACKAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface CheckpointStoreOptions {
  /** Largest package the store accepts, in bytes. Exports and uploads above it are refused. */
  packageMaxBytes?: number;
}

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

function isRolledVolume(value: unknown): value is RolledVolume {
  if (typeof value !== "object" || value === null) return false;
  const volume = value as Partial<RolledVolume>;
  return (
    typeof volume.volumeId === "string" &&
    typeof volume.name === "string" &&
    typeof volume.engineName === "string" &&
    typeof volume.path === "string"
  );
}

function isPendingRollback(value: unknown): value is PendingRollback {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Partial<PendingRollback>;
  return (
    pending.version === ROLLBACK_VERSION &&
    typeof pending.boxId === "string" &&
    isBoxId(pending.boxId) &&
    typeof pending.hostId === "string" &&
    typeof pending.boxName === "string" &&
    typeof pending.checkpointLabel === "string" &&
    (pending.createdBy === null || typeof pending.createdBy === "string") &&
    typeof pending.createdAt === "string" &&
    typeof pending.checkpointId === "string" &&
    isCheckpointId(pending.checkpointId) &&
    typeof pending.safetyCheckpointId === "string" &&
    isCheckpointId(pending.safetyCheckpointId) &&
    Array.isArray(pending.replaced) &&
    pending.replaced.every(isRolledVolume) &&
    Array.isArray(pending.restored) &&
    pending.restored.every(isRolledVolume)
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
    (record.boxId === null || typeof record.boxId === "string") &&
    typeof record.pinned === "boolean" &&
    (record.spec === null || (typeof record.spec === "object" && record.spec !== null)) &&
    (record.trash === undefined || record.trash === null || typeof record.trash === "object") &&
    Array.isArray(record.data)
  );
}

/**
 * `DATA_DIR/checkpoints/<id>.json`, one file per checkpoint, shared by every host like the volume records. Writes are
 * atomic and mode 600. Reads go to disk: checkpoints are few, and they are read for listings and mutations only.
 */
export class CheckpointStore {
  private tail: Promise<void> = Promise.resolve();
  /** The packages exported or uploaded and waiting to be downloaded or imported. Shared by every host. */
  readonly packages: PackageStore;
  /** Checkpoints whose package is being written. Retention and deletion leave their snapshots alone meanwhile. */
  readonly exporting = new Set<string>();
  /** Hosts that were removed, so a write that was already on its way cannot bring one of their records back. */
  private readonly closed = new Set<string>();

  constructor(
    private readonly dataDir: string,
    options: CheckpointStoreOptions = {},
  ) {
    this.packages = new PackageStore(dataDir, options.packageMaxBytes ?? DEFAULT_PACKAGE_MAX_BYTES);
  }

  /** Refuses later checkpoint writes for a host that was removed. Removals stay allowed, so the caller can clean up. */
  closeHost(hostId: string): void {
    this.closed.add(hostId);
  }

  /** Puts a host id back into service, when a host with it is added again. */
  openHost(hostId: string): void {
    this.closed.delete(hostId);
  }

  isClosed(hostId: string): boolean {
    return this.closed.has(hostId);
  }

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

  /** `DATA_DIR/checkpoints/schedules`: one file per box that has a checkpoint schedule. */
  scheduleDir(): string {
    return join(this.dir(), "schedules");
  }

  readSchedule(boxId: string): BoxSchedule | null {
    if (!isBoxId(boxId)) return null;
    let text: string;
    try {
      text = readFileSync(this.schedulePath(boxId), "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    try {
      const parsed = BoxScheduleSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.boxId === boxId) return parsed.data;
      log.warn("checkpoint.schedule_unreadable", { box: boxId, error: "not a schedule record" });
    } catch (e) {
      log.warn("checkpoint.schedule_unreadable", { box: boxId, error: String(e) });
    }
    return null;
  }

  schedules(): BoxSchedule[] {
    let names: string[];
    try {
      names = readdirSync(this.scheduleDir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    const found: BoxSchedule[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const schedule = this.readSchedule(name.slice(0, -".json".length));
      if (schedule) found.push(schedule);
    }
    return found;
  }

  writeSchedule(schedule: BoxSchedule): void {
    if (this.closed.has(schedule.hostId)) throw hostGone(schedule.hostId);
    ensureDataDir(this.dataDir);
    mkdirSync(this.scheduleDir(), { recursive: true, mode: DIR_MODE });
    writeFileAtomic(this.schedulePath(schedule.boxId), `${JSON.stringify(schedule, null, 2)}\n`);
  }

  removeSchedule(boxId: string): void {
    if (!isBoxId(boxId)) return;
    try {
      unlinkSync(this.schedulePath(boxId));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  private schedulePath(boxId: string): string {
    if (!isBoxId(boxId)) throw new Error(`refusing a schedule path for ${boxId}`);
    return join(this.scheduleDir(), `${boxId}.json`);
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
    if (this.closed.has(record.hostId)) throw hostGone(record.hostId);
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
    if (this.closed.has(record.hostId)) throw hostGone(record.hostId);
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
      log.warn("checkpoint.rollback_unreadable", { box: boxId, error: String(e) });
      return null;
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
      return { ...parsed, trash: parsed.trash ?? null };
    } catch (e) {
      log.warn("checkpoint.unreadable", { id, error: String(e) });
      return null;
    }
  }
}
