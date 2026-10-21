/** Tar archives in the shapes the engine sends for `docker cp`, so the archive reader runs without a daemon. */

const BLOCK = 512;

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

/** A PAX record, `<length> <key>=<value>\n`. The length counts the whole record, including its own digits. */
export function paxRecord(key: string, value: string): string {
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
