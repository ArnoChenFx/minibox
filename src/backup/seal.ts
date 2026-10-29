import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * A backup is sealed with a passphrase: an scrypt key, then AES-256-GCM over fixed-size chunks. Each chunk's
 * authenticated data holds the header, the chunk index and the chunk's length field, which carries the final-chunk
 * flag. A reordered, truncated, extended or edited archive therefore fails to open. The header stores a verifier of
 * the key, so a wrong passphrase is told apart from a damaged file before any chunk is decrypted.
 */

const SEAL_MAGIC = Buffer.from("MBBACKUP", "ascii");
const SEAL_VERSION = 1;
export const SEAL_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_LOG_N = 17;
/** The scrypt cost a header may name. The upper bound keeps a crafted file from forcing gigabytes of memory. */
const MIN_LOG_N = 10;
const MAX_LOG_N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const VERIFIER_BYTES = 16;
const TAG_BYTES = 16;
const HEADER_BYTES = SEAL_MAGIC.length + 1 + 1 + 2 + SALT_BYTES + VERIFIER_BYTES;
const FINAL_FLAG = 0x80000000;
const VERIFIER_LABEL = "minibox backup verifier";

export type ArchiveRejection = "invalid" | "passphrase" | "not_backup";

/** An archive the reader refuses. The reason decides the response: a wrong passphrase is its own answer. */
export class ArchiveRejected extends Error {
  constructor(
    readonly reason: ArchiveRejection,
    detail: string,
  ) {
    super(detail);
    this.name = "ArchiveRejected";
  }
}

export type ByteSink = (bytes: Uint8Array) => Promise<void>;

function deriveKey(passphrase: string, salt: Buffer, logN: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const options = { N: 2 ** logN, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };
    scrypt(passphrase, salt, KEY_BYTES, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function verifierOf(key: Buffer): Buffer {
  return createHmac("sha256", key).update(VERIFIER_LABEL).digest().subarray(0, VERIFIER_BYTES);
}

function nonceOf(index: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

function aadOf(header: Buffer, index: number, lengthField: Buffer): Buffer {
  const indexField = Buffer.alloc(8);
  indexField.writeBigUInt64BE(BigInt(index));
  return Buffer.concat([header, indexField, lengthField]);
}

/** Seals a stream of bytes. `finish` must run after the last write, or the archive is truncated and will not open. */
export class SealWriter {
  private readonly pieces: Buffer[] = [];
  private pending = 0;
  private index = 0;
  private finished = false;

  private constructor(
    private readonly key: Buffer,
    private readonly header: Buffer,
    private readonly sink: ByteSink,
  ) {}

  static async open(sink: ByteSink, passphrase: string, options: { logN?: number } = {}): Promise<SealWriter> {
    const logN = options.logN ?? DEFAULT_LOG_N;
    if (!Number.isInteger(logN) || logN < MIN_LOG_N || logN > MAX_LOG_N) {
      throw new RangeError(`the scrypt cost must be between ${MIN_LOG_N} and ${MAX_LOG_N}`);
    }
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, salt, logN);
    const header = Buffer.alloc(HEADER_BYTES);
    SEAL_MAGIC.copy(header, 0);
    header[8] = SEAL_VERSION;
    header[9] = logN;
    salt.copy(header, 12);
    verifierOf(key).copy(header, 12 + SALT_BYTES);
    await sink(header);
    return new SealWriter(key, header, sink);
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.finished) throw new Error("the seal is already finished");
    if (data.byteLength === 0) return;
    this.pieces.push(Buffer.from(data));
    this.pending += data.byteLength;
    while (this.pending > SEAL_CHUNK_BYTES) await this.emit(this.take(SEAL_CHUNK_BYTES), false);
  }

  async finish(): Promise<void> {
    if (this.finished) throw new Error("the seal is already finished");
    this.finished = true;
    try {
      await this.emit(this.take(this.pending), true);
    } finally {
      this.key.fill(0);
    }
  }

  private take(count: number): Buffer {
    const out = Buffer.alloc(count);
    let filled = 0;
    while (filled < count) {
      const piece = this.pieces[0];
      if (!piece) throw new Error("the seal ran out of bytes");
      const used = Math.min(piece.length, count - filled);
      piece.copy(out, filled, 0, used);
      filled += used;
      if (used === piece.length) this.pieces.shift();
      else this.pieces[0] = piece.subarray(used);
    }
    this.pending -= count;
    return out;
  }

  private async emit(plain: Buffer, final: boolean): Promise<void> {
    const lengthField = Buffer.alloc(4);
    lengthField.writeUInt32BE(plain.length + (final ? FINAL_FLAG : 0));
    const cipher = createCipheriv("aes-256-gcm", this.key, nonceOf(this.index), { authTagLength: TAG_BYTES });
    cipher.setAAD(aadOf(this.header, this.index, lengthField));
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    this.index += 1;
    await this.sink(Buffer.concat([lengthField, sealed]));
  }
}

/** Reads a byte stream in exact lengths, so a parser never sees a partial field. */
export class ByteReader {
  private readonly pieces: Buffer[] = [];
  private available = 0;
  private iterator: AsyncIterator<Uint8Array> | null;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Exactly `count` bytes, or null when the input ends before the first of them. Ending partway through is an error. */
  async optional(count: number): Promise<Buffer | null> {
    if (await this.fill(count)) return this.take(count);
    if (this.available === 0) return null;
    throw truncated();
  }

  async exact(count: number): Promise<Buffer> {
    const bytes = await this.optional(count);
    if (bytes === null) throw truncated();
    return bytes;
  }

  /** Up to `count` bytes, without consuming them. Shorter only when the input ends first. */
  async peek(count: number): Promise<Buffer> {
    await this.fill(count);
    const out = Buffer.alloc(Math.min(count, this.available));
    let filled = 0;
    for (const piece of this.pieces) {
      if (filled === out.length) break;
      const used = Math.min(piece.length, out.length - filled);
      piece.copy(out, filled, 0, used);
      filled += used;
    }
    return out;
  }

  /** True when no byte is left. Reads ahead by one byte, so it is only asked at the end of a structure. */
  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }

  async close(): Promise<void> {
    const iterator = this.iterator;
    this.iterator = null;
    await iterator?.return?.();
  }

  private async fill(count: number): Promise<boolean> {
    while (this.available < count) {
      if (!this.iterator) return false;
      const next = await this.iterator.next();
      if (next.done) {
        this.iterator = null;
        return false;
      }
      if (next.value.byteLength === 0) continue;
      const piece = Buffer.from(next.value);
      this.pieces.push(piece);
      this.available += piece.length;
    }
    return true;
  }

  private take(count: number): Buffer {
    const out = Buffer.alloc(count);
    let filled = 0;
    while (filled < count) {
      const piece = this.pieces[0];
      if (!piece) throw new Error("the reader ran out of bytes");
      const used = Math.min(piece.length, count - filled);
      piece.copy(out, filled, 0, used);
      filled += used;
      if (used === piece.length) this.pieces.shift();
      else this.pieces[0] = piece.subarray(used);
    }
    this.available -= count;
    return out;
  }
}

function truncated(): ArchiveRejected {
  return new ArchiveRejected("invalid", "the backup is truncated");
}

/** Opens a sealed stream. Each chunk is checked before its bytes are returned, and the end must come on the final chunk. */
export class SealReader {
  private constructor(
    private readonly reader: ByteReader,
    private readonly key: Buffer,
    private readonly header: Buffer,
  ) {}

  static async open(reader: ByteReader, passphrase: string): Promise<SealReader> {
    const head = await reader.peek(HEADER_BYTES);
    if (head.length < SEAL_MAGIC.length || !head.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) {
      throw new ArchiveRejected("not_backup", "the file is not a MiniBox backup");
    }
    if (head.length < HEADER_BYTES) throw truncated();
    const header = await reader.exact(HEADER_BYTES);
    if (header[8] !== SEAL_VERSION) throw new ArchiveRejected("invalid", `backup format ${header[8]} is not supported`);
    const logN = header[9] ?? 0;
    if (logN < MIN_LOG_N || logN > MAX_LOG_N || header.readUInt16BE(10) !== 0) {
      throw new ArchiveRejected("invalid", "the backup header is damaged");
    }
    const salt = header.subarray(12, 12 + SALT_BYTES);
    const verifier = header.subarray(12 + SALT_BYTES, HEADER_BYTES);
    const key = await deriveKey(passphrase, salt, logN);
    if (!timingSafeEqual(verifierOf(key), verifier)) {
      key.fill(0);
      throw new ArchiveRejected("passphrase", "the passphrase does not open this backup, or its header is damaged");
    }
    return new SealReader(reader, key, Buffer.from(header));
  }

  async *plaintext(): AsyncGenerator<Buffer> {
    let index = 0;
    try {
      for (;;) {
        const lengthField = await this.reader.optional(4);
        if (lengthField === null) throw new ArchiveRejected("invalid", "the backup ends before its last chunk");
        const word = lengthField.readUInt32BE(0);
        const final = word >= FINAL_FLAG;
        const length = final ? word - FINAL_FLAG : word;
        if (length > SEAL_CHUNK_BYTES) throw new ArchiveRejected("invalid", "a backup chunk is larger than allowed");
        const sealed = await this.reader.exact(length + TAG_BYTES);
        const plain = this.decrypt(index, lengthField, sealed, length);
        index += 1;
        yield plain;
        if (final) {
          if (!(await this.reader.atEnd())) {
            throw new ArchiveRejected("invalid", "the backup has data after its last chunk");
          }
          return;
        }
      }
    } finally {
      this.key.fill(0);
    }
  }

  private decrypt(index: number, lengthField: Buffer, sealed: Buffer, length: number): Buffer {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonceOf(index), { authTagLength: TAG_BYTES });
      decipher.setAAD(aadOf(this.header, index, lengthField));
      decipher.setAuthTag(sealed.subarray(length));
      return Buffer.concat([decipher.update(sealed.subarray(0, length)), decipher.final()]);
    } catch {
      throw new ArchiveRejected("invalid", "the backup is damaged or was changed");
    }
  }
}
