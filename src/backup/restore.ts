import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DIR_MODE, ensureDataDir, SECRET_FILE_MODE } from "../data-dir";
import { isEnoent, writeAll } from "./io";
import { ByteReader, SealReader } from "./seal";
import { readTar, type TarEntry } from "./tar";

/** The target already holds files. A restore never merges into a live or partly restored DATA_DIR. */
export class RestoreRefused extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RestoreRefused";
  }
}

/**
 * Restores a backup into DATA_DIR. Run it with MiniBox stopped, into a DATA_DIR that is missing or empty. The archive is
 * unpacked into a hidden folder inside DATA_DIR and moved into place only once every entry has been checked, so a
 * damaged archive leaves no partial data behind. Returns the number of entries restored.
 */
export async function restoreArchive(file: string, dataDir: string, passphrase: string): Promise<number> {
  await prepareTarget(dataDir);
  const staging = await mkdtemp(join(dataDir, ".restore-"));
  try {
    const source = new ByteReader(createReadStream(file));
    let count = 0;
    try {
      const sealed = await SealReader.open(source, passphrase);
      const plaintext = new ByteReader(sealed.plaintext());
      try {
        count = await readTar(plaintext, (entry) => extract(staging, entry));
      } finally {
        await plaintext.close();
      }
    } finally {
      await source.close();
    }
    for (const name of await readdir(staging)) await rename(join(staging, name), join(dataDir, name));
    ensureDataDir(dataDir);
    return count;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function prepareTarget(dataDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch (e) {
    if (isEnoent(e)) {
      await mkdir(dataDir, { recursive: true, mode: DIR_MODE });
      return;
    }
    throw e;
  }
  if (names.length > 0) throw new RestoreRefused(`${dataDir} is not empty. Restore into an empty DATA_DIR.`);
}

async function extract(root: string, entry: TarEntry): Promise<void> {
  const target = join(root, ...entry.name.split("/"));
  if (entry.type === "dir") {
    await mkdir(target, { recursive: true, mode: DIR_MODE });
    return;
  }
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
  const handle = await open(target, "wx", SECRET_FILE_MODE);
  try {
    for await (const piece of entry.content()) await writeAll(handle, piece);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
