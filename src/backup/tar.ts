import { cString, MAX_RECORD, numeric, parsePax } from "../lib/tar";
import { ArchiveRejected, type ByteReader } from "./seal";

/**
 * The tar format of a backup. The writer emits regular files and directories in USTAR, with a PAX `path` record for a
 * name USTAR cannot hold. The reader accepts exactly that subset, and refuses anything else: links, devices, other
 * extended keys, bad checksums, unsafe names, and non-zero padding.
 */

const BLOCK = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;
const MAX_NAME_BYTES = 4096;
const MAX_SIZE = 8 * 1024 ** 3 - 1;
const READ_CHUNK = 64 * 1024;
const USTAR_MAGIC = Buffer.from("ustar\0", "ascii");
const USTAR_VERSION = Buffer.from("00", "ascii");
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type TarSink = (bytes: Uint8Array) => Promise<void>;

/** Refuses a path that could escape the directory it is restored into, or that is not a plain relative path. */
export function checkEntryName(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name) > MAX_NAME_BYTES) return false;
  if (name.startsWith("/") || name.includes("\\") || [...name].some(isControl)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

export class TarWriter {
  private closed = false;
  private readonly mtime = Math.floor(Date.now() / 1000);

  constructor(private readonly sink: TarSink) {}

  async directory(name: string): Promise<void> {
    this.guard(name);
    await this.header(name, 0, "5", DIR_MODE);
  }

  /** Writes a regular file. `body` must yield exactly `size` bytes, or the archive is refused rather than left wrong. */
  async file(name: string, size: number, body: AsyncIterable<Uint8Array>): Promise<void> {
    this.guard(name);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) {
      throw new RangeError(`${name} is too large for a backup entry`);
    }
    await this.header(name, size, "0", FILE_MODE);
    let written = 0;
    for await (const piece of body) {
      written += piece.byteLength;
      if (written > size) throw new Error(`${name} grew while it was being backed up`);
      await this.sink(piece);
    }
    if (written !== size) throw new Error(`${name} changed size while it was being backed up`);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padding > 0) await this.sink(Buffer.alloc(padding));
  }

  /** Writes the end-of-archive marker. Nothing may be written after it. */
  async close(): Promise<void> {
    if (this.closed) throw new Error("the archive is already closed");
    this.closed = true;
    await this.sink(Buffer.alloc(BLOCK * 2));
  }

  private guard(name: string): void {
    if (this.closed) throw new Error("the archive is already closed");
    if (!checkEntryName(name)) throw new Error(`refusing to archive ${JSON.stringify(name)}`);
  }

  private async header(name: string, size: number, type: "0" | "5", mode: number): Promise<void> {
    const split = splitName(name);
    if (split) {
      await this.sink(headerBlock(split.name, split.prefix, size, type, mode, this.mtime));
      return;
    }
    const record = paxRecord("path", name);
    const basename = name.slice(name.lastIndexOf("/") + 1);
    await this.sink(
      headerBlock(truncate(`PaxHeader/${basename}`, NAME_FIELD), "", record.length, "x", 0o600, this.mtime),
    );
    await this.sink(record);
    const padding = (BLOCK - (record.length % BLOCK)) % BLOCK;
    if (padding > 0) await this.sink(Buffer.alloc(padding));
    await this.sink(headerBlock(truncate(name, NAME_FIELD), "", size, type, mode, this.mtime));
  }
}

function splitName(name: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(name) <= NAME_FIELD) return { name, prefix: "" };
  for (let at = name.lastIndexOf("/"); at > 0; at = name.lastIndexOf("/", at - 1)) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (Buffer.byteLength(prefix) <= PREFIX_FIELD && Buffer.byteLength(rest) <= NAME_FIELD) {
      return { name: rest, prefix };
    }
  }
  return null;
}

/** The longest prefix of `text` that fits in `max` bytes, cut at a character boundary. */
function truncate(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

function paxRecord(key: string, value: string): Buffer {
  const rest = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
  return Buffer.concat([Buffer.from(String(length), "ascii"), rest]);
}

function writeOctal(block: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8);
  if (text.length > width - 1) throw new RangeError("a tar header field is too large");
  block.write(`${text.padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function headerBlock(name: string, prefix: string, size: number, type: string, mode: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, NAME_FIELD, "utf8");
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, "ascii");
  USTAR_MAGIC.copy(block, 257);
  USTAR_VERSION.copy(block, 263);
  block.write(prefix, 345, PREFIX_FIELD, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

export interface TarEntry {
  readonly name: string;
  readonly type: "file" | "dir";
  readonly size: number;
  /** The body of a file, in order. It can be read once. Unread bytes are skipped after the visitor returns. */
  content(): AsyncGenerator<Buffer>;
}

function invalid(detail: string): ArchiveRejected {
  return new ArchiveRejected("invalid", detail);
}

function isZero(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function parseField<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof ArchiveRejected) throw e;
    throw invalid(e instanceof Error ? e.message : String(e));
  }
}

function checkChecksum(header: Buffer): void {
  const stored = parseField(() => numeric(header.subarray(148, 156)));
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  if (sum !== stored) throw invalid("a tar header checksum does not match");
}

function nameOf(header: Buffer, pax: Map<string, string>): string {
  const path = pax.get("path");
  if (path !== undefined) return path;
  const prefix = cString(header.subarray(345, 345 + PREFIX_FIELD));
  const short = cString(header.subarray(0, NAME_FIELD));
  return prefix ? `${prefix}/${short}` : short;
}

async function skip(reader: ByteReader, count: number): Promise<void> {
  let left = count;
  while (left > 0) {
    const step = Math.min(READ_CHUNK, left);
    await reader.exact(step);
    left -= step;
  }
}

async function paddingOf(reader: ByteReader, size: number): Promise<void> {
  const padding = (BLOCK - (size % BLOCK)) % BLOCK;
  if (padding === 0) return;
  if (!isZero(await reader.exact(padding))) throw invalid("a tar entry's padding is damaged");
}

/**
 * Reads a whole tar archive, handing each entry to `visit` in order. Returns the number of entries. The archive must
 * end with the zero trailer and nothing after it. Entries are visited once each, so a visitor writes them as they come.
 */
export async function readTar(reader: ByteReader, visit: (entry: TarEntry) => Promise<void>): Promise<number> {
  const seen = new Set<string>();
  let count = 0;
  let pax = new Map<string, string>();
  for (;;) {
    const header = await reader.optional(BLOCK);
    if (header === null) throw invalid("the archive ends without its trailer");
    if (isZero(header)) {
      if (!isZero(await reader.exact(BLOCK))) throw invalid("the archive trailer is damaged");
      if (!(await reader.atEnd())) throw invalid("the archive has data after its trailer");
      if (pax.size > 0) throw invalid("an extended header has no entry after it");
      return count;
    }
    checkChecksum(header);
    if (!header.subarray(257, 263).equals(USTAR_MAGIC) || !header.subarray(263, 265).equals(USTAR_VERSION)) {
      throw invalid("the archive is not in the backup's tar format");
    }
    const type = String.fromCharCode(header[156] ?? 0);
    const size = parseField(() => numeric(header.subarray(124, 136)));
    if (type === "x") {
      if (size > MAX_RECORD) throw invalid("an extended header is too large");
      const record = await reader.exact(size);
      await paddingOf(reader, size);
      pax = parseField(() => parsePax(record));
      for (const key of pax.keys())
        if (key !== "path") throw invalid(`the extended header key ${key} is not supported`);
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "5")
      throw invalid(`the entry type ${JSON.stringify(type)} is not supported`);
    const kind = type === "5" ? "dir" : "file";
    if (kind === "dir" && size !== 0) throw invalid("a directory entry has a body");
    const name = nameOf(header, pax);
    pax = new Map();
    if (!checkEntryName(name)) throw invalid(`the entry name ${JSON.stringify(name)} is not allowed`);
    if (seen.has(name)) throw invalid(`the archive holds ${name} twice`);
    seen.add(name);
    count += 1;
    if (kind === "dir") {
      await visit({ name, type: "dir", size: 0, content: emptyContent });
      continue;
    }
    let read = 0;
    let started = false;
    const entry: TarEntry = {
      name,
      type: "file",
      size,
      content: async function* () {
        if (started) throw new Error(`${name} was already read`);
        started = true;
        while (read < size) {
          const step = Math.min(READ_CHUNK, size - read);
          const piece = await reader.exact(step);
          read += step;
          yield piece;
        }
      },
    };
    await visit(entry);
    await skip(reader, size - read);
    await paddingOf(reader, size);
  }
}

async function* emptyContent(): AsyncGenerator<Buffer> {}
