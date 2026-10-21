import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { ensureDataDir, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import { isVolumeId, newVolumeId } from "./id";
import { implicitPools } from "./pools";
import { type PoolHealth, type PoolsFile, POOLS_VERSION, type VolumeRecord, VOLUME_VERSION } from "./types";

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

function isRecord(value: unknown): value is VolumeRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<VolumeRecord>;
  return (
    record.version === VOLUME_VERSION &&
    typeof record.id === "string" &&
    isVolumeId(record.id) &&
    typeof record.name === "string" &&
    typeof record.hostId === "string" &&
    typeof record.pool === "string" &&
    typeof record.engineName === "string" &&
    (record.ownership === "owned" || record.ownership === "independent")
  );
}

function isPools(value: unknown): value is PoolsFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<PoolsFile>;
  return file.version === POOLS_VERSION && Array.isArray(file.pools) && typeof file.roles === "object";
}

/**
 * `DATA_DIR/volumes/<id>.json` and `DATA_DIR/pools.json`. Writes are atomic and mode 600.
 * One store is shared by every host; each record names the host its engine volume was created on.
 */
export class VolumeStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly health = new Map<string, PoolHealth>();

  constructor(private readonly dataDir: string) {}

  dir(): string {
    return join(this.dataDir, "volumes");
  }

  poolsPath(): string {
    return join(this.dataDir, "pools.json");
  }

  pathFor(id: string): string {
    if (!isVolumeId(id)) throw new Error(`refusing a volume path for ${id}`);
    return join(this.dir(), `${id}.json`);
  }

  /**
   * Runs `fn` only after every earlier mutation has finished. Not re-entrant:
   * a function inside the lock must not call `exclusive` again.
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
    let id = newVolumeId();
    for (let attempt = 0; attempt < 5 && this.read(id); attempt++) id = newVolumeId();
    if (this.read(id)) throw new Error("could not allocate a volume id");
    return id;
  }

  list(): VolumeRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    const records: VolumeRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isVolumeId(id)) continue;
      const record = this.read(id);
      if (record) records.push(record);
    }
    return records;
  }

  read(id: string): VolumeRecord | null {
    if (!isVolumeId(id)) return null;
    return this.readJson(this.pathFor(id), isRecord, "volume.unreadable", id);
  }

  /** Id, display name, or engine name. Engine names are only unique per host, so pass `hostId` when you have one. */
  resolve(ref: string, hostId?: string): VolumeRecord | null {
    const direct = this.read(ref);
    if (direct) return direct;
    const matches = this.list().filter((record) => record.name === ref || record.engineName === ref);
    if (hostId) return matches.find((record) => record.hostId === hostId) ?? null;
    return matches[0] ?? null;
  }

  findByEngine(hostId: string, engineName: string): VolumeRecord | null {
    return this.list().find((record) => record.hostId === hostId && record.engineName === engineName) ?? null;
  }

  write(record: VolumeRecord): void {
    ensureDataDir(this.dataDir);
    writeFileAtomic(this.pathFor(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  remove(id: string): void {
    if (!isVolumeId(id)) return;
    try {
      unlinkSync(this.pathFor(id));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  /** Missing file means the implicit local pool. A corrupt file is left in place and treated as missing. */
  readPools(): PoolsFile {
    const file = this.readJson(this.poolsPath(), isPools, "pools.unreadable", "pools");
    return file ?? implicitPools();
  }

  writePools(file: PoolsFile): void {
    ensureDataDir(this.dataDir);
    writeFileAtomic(this.poolsPath(), `${JSON.stringify(file, null, 2)}\n`);
  }

  healthOf(hostId: string, pool: string): PoolHealth | null {
    return this.health.get(`${hostId}\0${pool}`) ?? null;
  }

  rememberHealth(health: PoolHealth): void {
    this.health.set(`${health.hostId}\0${health.pool}`, health);
  }

  private readJson<T>(path: string, guard: (value: unknown) => value is T, event: string, id: string): T | null {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!guard(parsed)) {
        log.warn(event, { id, error: "not a volume record" });
        return null;
      }
      return parsed;
    } catch (e) {
      log.warn(event, { id, error: String(e) });
      return null;
    }
  }
}
