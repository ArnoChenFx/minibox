import { createHash } from "node:crypto";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isEnoent, readBody, writeAll } from "./io";
import { type ArchiveEntry, DATABASE_FILES, listEntries } from "./layout";
import { SealWriter } from "./seal";
import { snapshotDatabase } from "./snapshot";
import { TarWriter } from "./tar";

export interface DatabaseSource {
  readonly name: (typeof DATABASE_FILES)[number];
  /** The live file, or `:memory:` for a store that has no file. Such a store is left out. */
  readonly path: string;
}

export interface ArchiveOptions {
  readonly dataDir: string;
  readonly databases: readonly DatabaseSource[];
  readonly passphrase: string;
  /** The file to write. It must not exist yet, and its folder must exist. */
  readonly output: string;
  readonly logN?: number;
  readonly log?: (line: string) => void;
}

export interface ArchiveSummary {
  readonly bytes: number;
  readonly sha256: string;
  readonly entries: number;
}

/**
 * Writes a sealed backup of DATA_DIR to `output`. Each SQLite store is copied first, so each copy is consistent with
 * itself, and the other files are read one by one. A file replaced meanwhile by an atomic rename is archived as the
 * version its handle opened, whole. Consistency holds per store, not across the folder. A failure leaves a partial
 * file, which the caller removes.
 */
export async function writeArchive(options: ArchiveOptions): Promise<ArchiveSummary> {
  const file = await open(options.output, "wx", 0o600);
  let staging: string | null = null;
  try {
    staging = await mkdtemp(join(dirname(options.output), ".snapshot-"));
    const snapshots = await snapshotStores(options.databases, staging, options.log);
    const listed = await listEntries(options.dataDir);
    const entries = [...listed, ...snapshots].toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const hash = createHash("sha256");
    let bytes = 0;
    const sink = async (chunk: Uint8Array): Promise<void> => {
      hash.update(chunk);
      bytes += chunk.byteLength;
      await writeAll(file, chunk);
    };
    const seal = await SealWriter.open(sink, options.passphrase, { logN: options.logN });
    const tar = new TarWriter((chunk) => seal.write(chunk));
    let written = 0;
    for (const entry of entries) {
      options.log?.(`Archiving ${entry.rel}\n`);
      if (await writeEntry(tar, entry)) written += 1;
      else options.log?.(`Left out ${entry.rel}: it was removed while the backup ran\n`);
    }
    await tar.close();
    await seal.finish();
    await file.sync();
    return { bytes, sha256: hash.digest("hex"), entries: written };
  } finally {
    await file.close();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function snapshotStores(
  databases: readonly DatabaseSource[],
  staging: string,
  log: ((line: string) => void) | undefined,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  for (const database of databases) {
    if (database.path === ":memory:") continue;
    log?.(`Snapshotting ${database.name}\n`);
    const target = join(staging, database.name);
    await snapshotDatabase(database.path, target);
    entries.push({ rel: database.name, abs: target, kind: "file" });
  }
  return entries;
}

/** Writes one entry. Returns false when a file listed earlier has since been removed, so nothing is written for it. */
async function writeEntry(tar: TarWriter, entry: ArchiveEntry): Promise<boolean> {
  if (entry.kind === "dir") {
    await tar.directory(entry.rel);
    return true;
  }
  let file: FileHandle;
  try {
    file = await open(entry.abs, "r");
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  try {
    const { size } = await file.stat();
    await tar.file(entry.rel, size, readBody(file, size));
    return true;
  } finally {
    await file.close();
  }
}
