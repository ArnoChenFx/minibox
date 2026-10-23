import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DIR_MODE, ensureDataDir, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import { isPackageId, newPackageId, PACKAGE_EXTENSION, PACKAGE_TTL_MS, PACKAGE_VERSION } from "./package";

/** What is known about a stored package. The file itself is `<id>.mbckpt`, beside this `<id>.json`. */
export const PackageMetaSchema = z.strictObject({
  version: z.literal(PACKAGE_VERSION),
  id: z.string().refine(isPackageId, "not a package id"),
  origin: z.enum(["export", "upload", "target"]),
  checkpointId: z.string().nullable(),
  hostId: z.string().nullable(),
  createdBy: z.string().nullable(),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type PackageMeta = z.infer<typeof PackageMetaSchema>;

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

export function isExpired(meta: PackageMeta, now: number): boolean {
  return Date.parse(meta.expiresAt) <= now;
}

/** When a package made at `now` stops being downloadable and is swept. */
export function expiresAtFor(now: number): string {
  return new Date(now + PACKAGE_TTL_MS).toISOString();
}

/**
 * Packages staged under `DATA_DIR/packages`, waiting to be downloaded or imported. Each lives for a day and is then
 * removed by the checkpoint sweep, with any file a crash left without metadata. A package being written is protected
 * while it is in flight, so the sweep never takes an upload or an export part way.
 */
export class PackageStore {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly dataDir: string,
    readonly maxBytes: number,
  ) {}

  dir(): string {
    return join(this.dataDir, "packages");
  }

  pathFor(id: string): string {
    if (!isPackageId(id)) throw new Error(`refusing a package path for ${id}`);
    return join(this.dir(), `${id}${PACKAGE_EXTENSION}`);
  }

  allocateId(): string {
    let id = newPackageId();
    for (let attempt = 0; attempt < 5 && this.exists(id); attempt++) id = newPackageId();
    if (this.exists(id)) throw new Error("could not allocate a package id");
    return id;
  }

  /** Marks a package as being written, so the sweep leaves it alone. The directory exists before the file is created. */
  begin(id: string): void {
    ensureDataDir(this.dataDir);
    mkdirSync(this.dir(), { recursive: true, mode: DIR_MODE });
    this.inFlight.add(id);
  }

  end(id: string): void {
    this.inFlight.delete(id);
  }

  read(id: string): PackageMeta | null {
    if (!isPackageId(id)) return null;
    let text: string;
    try {
      text = readFileSync(this.metaPath(id), "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    try {
      const parsed = PackageMetaSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.id === id) return parsed.data;
      log.warn("checkpoint.package_unreadable", { id, error: "not a package record" });
    } catch (e) {
      log.warn("checkpoint.package_unreadable", { id, error: String(e) });
    }
    return null;
  }

  write(meta: PackageMeta): void {
    ensureDataDir(this.dataDir);
    mkdirSync(this.dir(), { recursive: true, mode: DIR_MODE });
    writeFileAtomic(this.metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** Removes the file and its metadata. A missing one is not an error, so a retry can finish the job. */
  remove(id: string): void {
    if (!isPackageId(id)) return;
    for (const path of [this.pathFor(id), this.metaPath(id)]) {
      try {
        unlinkSync(path);
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }
  }

  /** Removes expired packages, metadata with no file, and files with no metadata that are not being written. */
  sweep(now = Date.now()): string[] {
    const removed: string[] = [];
    const files = this.names();
    const ids = new Set<string>();
    for (const name of files) {
      if (name.endsWith(".json") && isPackageId(name.slice(0, -".json".length)))
        ids.add(name.slice(0, -".json".length));
    }
    for (const id of ids) {
      if (this.inFlight.has(id)) continue;
      const meta = this.read(id);
      if (!meta || isExpired(meta, now) || !this.hasFile(id)) {
        this.remove(id);
        removed.push(id);
      }
    }
    for (const name of files) {
      if (!name.endsWith(PACKAGE_EXTENSION)) continue;
      const id = name.slice(0, -PACKAGE_EXTENSION.length);
      if (!isPackageId(id) || this.inFlight.has(id) || ids.has(id)) continue;
      this.remove(id);
      removed.push(id);
    }
    return removed;
  }

  list(): PackageMeta[] {
    const metas: PackageMeta[] = [];
    for (const name of this.names()) {
      if (!name.endsWith(".json")) continue;
      const meta = this.read(name.slice(0, -".json".length));
      if (meta) metas.push(meta);
    }
    return metas;
  }

  /** The size of the stored file, read from disk rather than trusted from the metadata. Null when it is gone. */
  fileBytes(id: string): number | null {
    try {
      return statSync(this.pathFor(id)).size;
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
  }

  private exists(id: string): boolean {
    return this.hasFile(id) || this.read(id) !== null;
  }

  private hasFile(id: string): boolean {
    try {
      statSync(this.pathFor(id));
      return true;
    } catch (e) {
      if (isEnoent(e)) return false;
      throw e;
    }
  }

  private metaPath(id: string): string {
    if (!isPackageId(id)) throw new Error(`refusing a package record path for ${id}`);
    return join(this.dir(), `${id}.json`);
  }

  private names(): string[] {
    try {
      return readdirSync(this.dir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
  }
}
