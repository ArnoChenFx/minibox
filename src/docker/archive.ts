import type { Readable } from "node:stream";

import { MAX_RECORD, numeric, parsePax } from "../lib/tar";
import { MAX_OWNER_ID, type PathStat, RuntimeError, type VolumeOwner } from "../runtime";

const BLOCK = 512;

/**
 * The owner of the first entry of a tar archive, given the bytes received so far. For `docker cp` of a path, that entry
 * is the path itself. A PAX `x` record applies to the header that follows it, and Docker uses one for ids that do not
 * fit the ustar fields. A PAX `g` record applies to every header after it. A GNU `L` or `K` record carries a name for the
 * entry after it, and the owner in its own header is not the entry's, so it is skipped and leaves the PAX records in
 * front of it in place. Returns null while the entry's header is incomplete, and throws when the bytes are not a tar
 * archive.
 */
export function firstEntryOwner(bytes: Buffer): VolumeOwner | null {
  let entry = new Map<string, string>();
  let global = new Map<string, string>();
  let offset = 0;
  for (;;) {
    if (bytes.length < offset + BLOCK) return null;
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) throw new Error("the archive ends before its first entry");
    const type = String.fromCharCode(header[156] ?? 0);
    const body = offset + BLOCK;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const size = numeric(header.subarray(124, 136));
      if (size > MAX_RECORD) throw new Error("a tar record is too large");
      if (bytes.length < body + size) return null;
      const data = bytes.subarray(body, body + size);
      if (type === "x") entry = parsePax(data);
      else if (type === "g") global = new Map([...global, ...parsePax(data)]);
      offset = body + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    return {
      uid: ownerId(entry.get("uid") ?? global.get("uid") ?? numeric(header.subarray(108, 116))),
      gid: ownerId(entry.get("gid") ?? global.get("gid") ?? numeric(header.subarray(116, 124))),
    };
  }
}

/**
 * Reads the owner of the first entry of a tar stream. Chunks are read only until that entry's header is complete, and
 * then the stream is destroyed, so the rest of a large directory is never sent.
 */
export async function readFirstEntryOwner(stream: Readable): Promise<VolumeOwner> {
  let bytes = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      const owner = firstEntryOwner(bytes);
      if (owner) return owner;
    }
    throw new Error("the archive ends before its first entry");
  } finally {
    stream.destroy();
  }
}

/** Go `os.FileMode` type bits. */
const MODE_DIR = 2 ** 31;
const MODE_SYMLINK = 2 ** 27;
/** Device, named pipe, socket, char device and irregular. */
const MODE_OTHER = [2 ** 26, 2 ** 25, 2 ** 24, 2 ** 21, 2 ** 19];

/** Decodes the engine's base64 JSON `X-Docker-Container-Path-Stat` header. */
export function parsePathStat(header: string | string[] | undefined, path: string): PathStat {
  const value = Array.isArray(header) ? header[0] : header;
  let raw: { name?: unknown; size?: unknown; mode?: unknown; linkTarget?: unknown };
  try {
    if (!value) throw new Error("missing");
    raw = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as typeof raw;
  } catch {
    throw new RuntimeError("engine", `the engine sent no usable path stat for ${path}`);
  }
  const mode = typeof raw.mode === "number" && Number.isSafeInteger(raw.mode) && raw.mode >= 0 ? raw.mode : null;
  if (mode === null) throw new RuntimeError("engine", `the engine sent no usable path stat for ${path}`);
  // Bitwise ops would truncate to int32 and lose ModeDir (1 << 31), so test the bits arithmetically.
  const has = (bit: number): boolean => Math.floor(mode / bit) % 2 === 1;
  const type: PathStat["type"] = has(MODE_DIR)
    ? "dir"
    : has(MODE_SYMLINK)
      ? "symlink"
      : MODE_OTHER.some(has)
        ? "other"
        : "file";
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    type,
    size: typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : 0,
    mode,
    linkTarget: typeof raw.linkTarget === "string" ? raw.linkTarget : "",
  };
}

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A tar archive of regular files for `putArchive` into a directory. Each file is owned by root and readable by root
 * only, which is what a helper running as root needs. Names are plain file names, so nothing can land outside the
 * directory.
 */
export function secretsArchive(files: { name: string; value: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    if (!SECRET_NAME.test(file.name)) throw new RuntimeError("invalid", `not a secret file name: ${file.name}`);
    const data = Buffer.from(file.value, "utf8");
    parts.push(ustarHeader(file.name, data.length), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function ustarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write("0000400\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/** A uid or gid from a PAX record, which is decimal text, or from a ustar field, which is already a number. */
function ownerId(value: string | number): number {
  const id = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : Number.NaN) : value;
  if (!Number.isSafeInteger(id) || id > MAX_OWNER_ID) throw new Error(`owner id ${value} is out of range`);
  return id;
}
