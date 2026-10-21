import type { Readable } from "node:stream";

import { MAX_OWNER_ID, type VolumeOwner } from "../runtime";

const BLOCK = 512;
/** Longest PAX or GNU record that is read. Docker's records are a few hundred bytes. */
const MAX_RECORD = 1024 * 1024;

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

/** A numeric header field: octal text, or base-256 when the high bit of the first byte is set. */
function numeric(field: Buffer): number {
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

/** A uid or gid from a PAX record, which is decimal text, or from a ustar field, which is already a number. */
function ownerId(value: string | number): number {
  const id = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : Number.NaN) : value;
  if (!Number.isSafeInteger(id) || id > MAX_OWNER_ID) throw new Error(`owner id ${value} is out of range`);
  return id;
}

/** `<length> <key>=<value>\n` records. The length counts the whole record, including its own digits. */
function parsePax(data: Buffer): Map<string, string> {
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
