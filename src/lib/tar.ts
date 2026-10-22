import type { Readable } from "node:stream";

/** Shared streaming tar header parsing for the engine archive API. */

const BLOCK = 512;
/** Longest PAX or GNU record that is read. Docker's records are a few hundred bytes. */
export const MAX_RECORD = 1024 * 1024;

/** The first entry of a tar archive: its header, with PAX and GNU long names applied, and up to `maxData` body bytes. */
export interface FirstEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  /** Body size from the header (the whole file, however much of it was read). */
  size: number;
  linkname: string;
  /** The first `min(size, maxData)` bytes of the body. Empty for anything but a regular file. */
  data: Buffer;
  /** Offset of the body's first byte in the bytes that were parsed, for a reader that goes on from there. */
  bodyAt: number;
}

/**
 * Parses the first entry of a tar archive from the bytes received so far, applying PAX `x`/`g` records (path,
 * linkpath, size) and GNU `L`/`K` long names. Returns null until the header and the wanted part of the body have
 * arrived, and throws when the bytes are not a tar archive.
 */
export function firstEntry(bytes: Buffer, maxData = 0): FirstEntry | null {
  let entry = new Map<string, string>();
  let global = new Map<string, string>();
  let longName: string | null = null;
  let longLink: string | null = null;
  let offset = 0;
  for (;;) {
    if (bytes.length < offset + BLOCK) return null;
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) throw new Error("the archive ends before its first entry");
    const flag = String.fromCharCode(header[156] ?? 0);
    const body = offset + BLOCK;
    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      const size = numeric(header.subarray(124, 136));
      if (size > MAX_RECORD) throw new Error("a tar record is too large");
      if (bytes.length < body + size) return null;
      const data = bytes.subarray(body, body + size);
      if (flag === "x") entry = parsePax(data);
      else if (flag === "g") global = new Map([...global, ...parsePax(data)]);
      else if (flag === "L") longName = cString(data);
      else longLink = cString(data);
      offset = body + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    const pax = (key: string): string | undefined => entry.get(key) ?? global.get(key);
    const paxSize = pax("size");
    const size = paxSize !== undefined && /^\d+$/.test(paxSize) ? Number(paxSize) : numeric(header.subarray(124, 136));
    const type: FirstEntry["type"] =
      flag === "0" || flag === "\0" || flag === "7"
        ? "file"
        : flag === "5"
          ? "dir"
          : flag === "2"
            ? "symlink"
            : "other";
    const want = type === "file" ? Math.min(size, maxData) : 0;
    if (bytes.length < body + want) return null;
    const prefix = cString(header.subarray(345, 500));
    const short = cString(header.subarray(0, 100));
    const name = pax("path") ?? longName ?? (prefix ? `${prefix}/${short}` : short);
    return {
      name: name.replace(/\/+$/, ""),
      type: type === "file" && name.endsWith("/") ? "dir" : type,
      size,
      linkname: pax("linkpath") ?? longLink ?? cString(header.subarray(157, 257)),
      data: Buffer.from(bytes.subarray(body, body + want)),
      bodyAt: body,
    };
  }
}

/**
 * Reads the first entry of a tar stream: chunks are read only until its header (and up to `maxData` body bytes of a
 * regular file) have arrived, then the stream is destroyed, so the rest of a large file or directory is never sent.
 */
export async function readFirstEntry(stream: Readable, maxData = 0): Promise<FirstEntry> {
  let bytes = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      const found = firstEntry(bytes, maxData);
      if (found) return found;
    }
    throw new Error("the archive ends before its first entry");
  } finally {
    stream.destroy();
  }
}

export function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

/** A numeric header field: octal text, or base-256 when the high bit of the first byte is set. */
export function numeric(field: Buffer): number {
  const first = field[0] ?? 0;
  if (first & 0x80) {
    let value = first & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = (field.toString("ascii").split("\0")[0] ?? "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid numeric field ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

/** `<length> <key>=<value>\n` records. The length counts the whole record, including its own digits. */
export function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  for (let pos = 0; pos < data.length;) {
    const space = data.indexOf(0x20, pos);
    const digits = space < 0 ? "" : data.subarray(pos, space).toString("ascii");
    const length = /^\d+$/.test(digits) ? Number(digits) : 0;
    const end = pos + length;
    if (length === 0 || space >= end || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("a PAX record is malformed");
    }
    const text = data.subarray(space + 1, end - 1).toString("utf8");
    const eq = text.indexOf("=");
    if (eq < 0) throw new Error("a PAX record is malformed");
    records.set(text.slice(0, eq), text.slice(eq + 1));
    pos = end;
  }
  return records;
}
