/** Minimal ustar helpers for volume file put/get via the Docker archive API. */

const BLOCK = 512;
/** uid/gid written into tar headers for `dev` (base template). */
export const DEV_UID = 1000;
export const DEV_GID = 1000;

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

function seal(block: Buffer): Buffer {
  block.fill(0x20, 148, 156);
  block.write(
    `${octal(
      block.reduce((sum, byte) => sum + byte, 0),
      7,
    )} `,
    148,
    "ascii",
  );
  return block;
}

function header(name: string, type: string, size: number, mode: number, uid: number, gid: number, link = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  const short = name.length <= 100 ? name : name.slice(0, 100);
  block.write(short, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(uid, 8), 108, "ascii");
  block.write(octal(gid, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, "ascii");
  block.write(type, 156, "ascii");
  if (link) block.write(link.slice(0, 100), 157, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  return seal(block);
}

function pad(data: Buffer): Buffer {
  const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return padding === 0 ? data : Buffer.concat([data, Buffer.alloc(padding)]);
}

const USTAR_NAME_MAX = 100;

/**
 * One entry's header. A name past the 100-byte ustar field goes in a GNU `L` record ahead of it, which the engine's tar
 * reader applies, so a long folder or file name is kept whole rather than cut short.
 */
function entry(name: string, type: string, size: number, mode: number, uid: number, gid: number): Buffer {
  const own = header(name, type, size, mode, uid, gid);
  if (Buffer.byteLength(name) <= USTAR_NAME_MAX) return own;
  const data = Buffer.from(`${name}\0`);
  return Buffer.concat([header("././@LongLink", "L", data.length, 0o644, 0, 0), pad(data), own]);
}

/** A single-file archive for `putArchive` into the file's parent directory. Entry name is the basename. */
export function fileArchive(
  basename: string,
  data: Buffer,
  opts?: { mode?: number; uid?: number; gid?: number },
): Buffer {
  const uid = opts?.uid ?? DEV_UID;
  const gid = opts?.gid ?? DEV_GID;
  const mode = opts?.mode ?? 0o644;
  return Buffer.concat([entry(basename, "0", data.length, mode, uid, gid), pad(data), Buffer.alloc(BLOCK * 2)]);
}

/** The header of one regular file whose body is streamed after it. */
export function fileHeader(
  basename: string,
  size: number,
  opts?: { mode?: number; uid?: number; gid?: number },
): Buffer {
  return entry(basename, "0", size, opts?.mode ?? 0o644, opts?.uid ?? DEV_UID, opts?.gid ?? DEV_GID);
}

/** What follows a streamed body: the padding to the next block, then the two zero blocks that end an archive. */
export function fileTrailer(size: number): Buffer {
  return Buffer.alloc(((BLOCK - (size % BLOCK)) % BLOCK) + BLOCK * 2);
}

/** A directory entry archive (empty dir) for creating parents via putArchive. */
export function dirArchive(basename: string, opts?: { mode?: number; uid?: number; gid?: number }): Buffer {
  const uid = opts?.uid ?? DEV_UID;
  const gid = opts?.gid ?? DEV_GID;
  const mode = opts?.mode ?? 0o755;
  const name = basename.endsWith("/") ? basename : `${basename}/`;
  return Buffer.concat([entry(name, "5", 0, mode, uid, gid), Buffer.alloc(BLOCK * 2)]);
}

export interface TarEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  data: Buffer;
  linkname: string;
  uid: number;
  gid: number;
}

function numeric(field: Buffer): number {
  const first = field[0] ?? 0;
  if (first & 0x80) {
    let value = first & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = (field.toString("ascii").split("\0")[0] ?? "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) return 0;
  return Number.parseInt(text, 8);
}

function typeOf(flag: string): TarEntry["type"] {
  if (flag === "0" || flag === "\0" || flag === "") return "file";
  if (flag === "5") return "dir";
  if (flag === "2") return "symlink";
  return "other";
}

/** Parse every regular entry from a ustar archive (skips PAX/GNU metadata bodies). */
export function parseTar(bytes: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;
  let pendingLink: string | null = null;
  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;
    const typeFlag = String.fromCharCode(block[156] ?? 0);
    const size = numeric(block.subarray(124, 136));
    const uid = numeric(block.subarray(108, 116));
    const gid = numeric(block.subarray(116, 124));
    const nameField = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const linkField = block.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
    const bodyStart = offset + BLOCK;
    const bodyEnd = bodyStart + size;
    const data = bytes.subarray(bodyStart, Math.min(bodyEnd, bytes.length));
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === "x" || typeFlag === "g" || typeFlag === "L" || typeFlag === "K") {
      if (typeFlag === "L") pendingName = data.toString("utf8").replace(/\0.*$/, "");
      if (typeFlag === "K") pendingLink = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    const name = (pendingName ?? nameField).replace(/^\.\//, "").replace(/\/+$/, typeFlag === "5" ? "/" : "");
    const linkname = pendingLink ?? linkField;
    pendingName = null;
    pendingLink = null;
    const type = typeOf(typeFlag);
    entries.push({
      name: name.replace(/\/$/, ""),
      type: type === "dir" || nameField.endsWith("/") ? (type === "file" ? "dir" : type) : type,
      size,
      data: Buffer.from(data),
      linkname,
      uid,
      gid,
    });
  }
  return entries;
}
