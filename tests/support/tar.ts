/** Tar archives in the shapes the engine sends for `docker cp`, so the archive reader runs without a daemon. */

const BLOCK = 512;

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

/** A PAX record, `<length> <key>=<value>\n`. The length counts the whole record, including its own digits. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length) length += 1;
  return `${length}${rest}`;
}

export interface HeaderFields {
  name: string;
  /** The typeflag. A directory unless said otherwise. */
  type?: string;
  uid?: number;
  gid?: number;
}

/** Writes the checksum of a header block, after any of its fields has been changed. */
export function seal(block: Buffer): Buffer {
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

/** A ustar header block with a valid checksum. */
export function header({ name, type = "5", uid = 0, gid = 0 }: HeaderFields, size = 0): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(0o755, 8), 100, "ascii");
  block.write(octal(uid, 8), 108, "ascii");
  block.write(octal(gid, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  return seal(block);
}

/** An entry: its header, then its data padded to whole blocks. */
export function entry(fields: HeaderFields, data: Buffer = Buffer.alloc(0)): Buffer {
  const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([header(fields, data.length), data, Buffer.alloc(padding)]);
}

/** A PAX `x` entry that holds the records for the header after it. */
export function paxEntry(records: Record<string, string>): Buffer {
  const data = Buffer.from(
    Object.entries(records)
      .map(([key, value]) => paxRecord(key, value))
      .join(""),
  );
  return entry({ name: "PaxHeaders.0", type: "x" }, data);
}

/** A PAX `g` entry, whose records apply to every header after it. */
export function paxGlobal(records: Record<string, string>): Buffer {
  const data = Buffer.from(
    Object.entries(records)
      .map(([key, value]) => paxRecord(key, value))
      .join(""),
  );
  return entry({ name: "pax_global_header", type: "g" }, data);
}

/** A GNU `L` entry that names the entry after it. */
export function gnuLongName(name: string): Buffer {
  return entry({ name: "././@LongLink", type: "L" }, Buffer.from(`${name}\0`));
}

/** An archive: its entries, then the two zero blocks that end it. */
export function archive(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)]);
}

/** A hand-built archive entry, for the validator's negative cases. Each field can be set away from the valid default. */
export interface TarEntry {
  name: string;
  body?: Buffer;
  dir?: boolean;
  mode?: number;
  typeflag?: string;
  linkname?: string;
  /** The 8 magic bytes. Defaults to POSIX `ustar\0` + `00`. */
  magic?: Buffer;
  prefix?: string;
  /** PAX records written in an `x` header before the entry. */
  pax?: Record<string, string>;
  /** Writes a wrong checksum. */
  badChecksum?: boolean;
}

const POSIX_MAGIC = Buffer.from("ustar\u000000", "latin1");
export const GNU_MAGIC = Buffer.from("ustar  \u0000", "latin1");

function putText(block: Buffer, offset: number, length: number, text: string): void {
  Buffer.from(text, "utf8").copy(block, offset, 0, length);
}

function putOctal(block: Buffer, offset: number, length: number, value: number): void {
  putText(block, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
  block[offset + length - 1] = 0;
}

function headerOf(fields: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const dir = fields.dir === true;
  putText(block, 0, 100, fields.name);
  putOctal(block, 100, 8, fields.mode ?? (dir ? 0o755 : 0o644));
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  putOctal(block, 124, 12, size);
  putOctal(block, 136, 12, 1_700_000_000);
  block.fill(0x20, 148, 156);
  putText(block, 156, 1, fields.typeflag ?? (dir ? "5" : "0"));
  putText(block, 157, 100, fields.linkname ?? "");
  (fields.magic ?? POSIX_MAGIC).copy(block, 257);
  if (fields.prefix) putText(block, 345, 155, fields.prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (fields.badChecksum) sum += 1;
  putText(block, 148, 6, sum.toString(8).padStart(6, "0"));
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function paxBody(records: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(records)) {
    const rest = Buffer.from(` ${key}=${value}\n`, "utf8");
    let length = rest.length + 1;
    while (length !== rest.length + String(length).length) length = rest.length + String(length).length;
    parts.push(Buffer.from(String(length), "ascii"), rest);
  }
  return Buffer.concat(parts);
}

function padFor(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** An archive of `entries`, ending with the two zero blocks unless `trailer` is false. */
export function tarBytes(entries: readonly TarEntry[], { trailer = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const item of entries) {
    if (item.pax) {
      const body = paxBody(item.pax);
      parts.push(headerOf({ name: "PaxHeaders/entry", typeflag: "x" }, body.length), body, padFor(body.length));
    }
    const body = item.dir ? Buffer.alloc(0) : (item.body ?? Buffer.alloc(0));
    parts.push(headerOf(item, body.length), body, padFor(body.length));
  }
  if (trailer) parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

/** The regular files of an archive written by `tarBytes`, by name. Directories and PAX headers are skipped. */
export function readTarFiles(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const magic = block.subarray(257, 263).toString("latin1");
    const prefix = magic === "ustar\u0000" ? cText(block.subarray(345, 500)) : "";
    const short = cText(block.subarray(0, 100));
    const name = prefix ? `${prefix}/${short}` : short;
    const size = Number.parseInt(cText(block.subarray(124, 136)).trim() || "0", 8);
    const flag = String.fromCharCode(block[156] ?? 0);
    offset += BLOCK;
    if (flag === "0" || flag === "\0") files.set(name, Buffer.from(bytes.subarray(offset, offset + size)));
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

function cText(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}
