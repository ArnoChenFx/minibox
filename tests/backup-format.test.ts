import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import {
  ArchiveRejected,
  ByteReader,
  DEFAULT_LOG_N,
  SEAL_CHUNK_BYTES,
  SealReader,
  SealWriter,
} from "../src/backup/seal";
import { checkEntryName, readTar, type TarEntry, TarWriter } from "../src/backup/tar";
import { archive, entry, GNU_MAGIC, header, paxEntry, tarBytes } from "./support/tar";

const PASSPHRASE = "correct horse battery staple";
const FAST_LOG_N = 10;
const HEADER_BYTES = 44;
const SALT_OFFSET = 12;
const RESERVED_OFFSET = 10;
const FIRST_CHUNK_BYTES = 4 + SEAL_CHUNK_BYTES + 16;

async function* pieces(bytes: Buffer, size = 1000): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

function changeByte(bytes: Buffer, offset: number, change: (value: number) => number): void {
  bytes.writeUInt8(change(bytes.readUInt8(offset)), offset);
}

async function sealBytes(plain: Buffer, passphrase = PASSPHRASE, logN = FAST_LOG_N): Promise<Buffer> {
  const parts: Buffer[] = [];
  const writer = await SealWriter.open(async (bytes) => void parts.push(Buffer.from(bytes)), passphrase, { logN });
  for (let at = 0; at < plain.length; at += 4096) await writer.write(plain.subarray(at, at + 4096));
  await writer.finish();
  return Buffer.concat(parts);
}

async function openSealed(sealed: Buffer, passphrase = PASSPHRASE): Promise<Buffer> {
  const reader = await SealReader.open(new ByteReader(pieces(sealed)), passphrase);
  const out: Buffer[] = [];
  for await (const chunk of reader.plaintext()) out.push(chunk);
  return Buffer.concat(out);
}

async function refusalOf(promise: Promise<unknown>): Promise<ArchiveRejected> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ArchiveRejected) return e;
    throw e;
  }
  throw new Error("expected the archive to be refused");
}

function refusedPlaintext(sealed: Buffer, passphrase = PASSPHRASE): Promise<ArchiveRejected> {
  return refusalOf(openSealed(sealed, passphrase));
}

describe("sealed archives", () => {
  test("round-trip at chunk boundaries, including empty and exact-size payloads", async () => {
    for (const size of [0, 1, SEAL_CHUNK_BYTES - 1, SEAL_CHUNK_BYTES, SEAL_CHUNK_BYTES + 1, 3 * SEAL_CHUNK_BYTES + 5]) {
      const plain = randomBytes(size);
      const sealed = await sealBytes(plain);
      expect((await openSealed(sealed)).equals(plain)).toBe(true);
    }
  });

  test("the sealed bytes do not contain the plaintext", async () => {
    const plain = Buffer.from(`access_key=${"z".repeat(64)} ${"needle".repeat(40)}`);
    const sealed = await sealBytes(plain);
    expect(sealed.includes(Buffer.from("needle"))).toBe(false);
    expect(sealed.includes(Buffer.from("access_key"))).toBe(false);
  });

  test("the default scrypt cost seals and opens", async () => {
    const plain = Buffer.from("default cost");
    const sealed = await sealBytes(plain, PASSPHRASE, DEFAULT_LOG_N);
    expect((await openSealed(sealed)).equals(plain)).toBe(true);
  });

  test("a wrong passphrase is told apart from damage", async () => {
    const sealed = await sealBytes(Buffer.from("payload"));
    expect((await refusedPlaintext(sealed, "a different passphrase")).reason).toBe("passphrase");
  });

  test("a changed byte in a chunk is refused as damage", async () => {
    const sealed = await sealBytes(randomBytes(3000));
    changeByte(sealed, HEADER_BYTES + 4 + 10, (value) => value ^ 0x01);
    expect((await refusedPlaintext(sealed)).reason).toBe("invalid");
  });

  test("a changed salt cannot be told from a wrong passphrase, so it is reported as one", async () => {
    const sealed = await sealBytes(randomBytes(3000));
    changeByte(sealed, SALT_OFFSET, (value) => value ^ 0x01);
    expect((await refusedPlaintext(sealed)).reason).toBe("passphrase");
  });

  test("non-zero reserved header bytes are refused as damage", async () => {
    const sealed = await sealBytes(Buffer.from("payload"));
    sealed[RESERVED_OFFSET] = 1;
    expect((await refusedPlaintext(sealed)).reason).toBe("invalid");
  });

  test("a chunk from another backup is refused, even under the same passphrase", async () => {
    const mine = await sealBytes(randomBytes(3000));
    const other = await sealBytes(randomBytes(3000));
    const spliced = Buffer.concat([other.subarray(0, HEADER_BYTES), mine.subarray(HEADER_BYTES)]);
    expect((await refusedPlaintext(spliced)).reason).toBe("invalid");
  });

  test("a truncated archive is refused", async () => {
    const sealed = await sealBytes(randomBytes(5000));
    expect((await refusedPlaintext(sealed.subarray(0, sealed.length - 100))).reason).toBe("invalid");
  });

  test("a header cut short is reported as truncation, not as a foreign file", async () => {
    const sealed = await sealBytes(Buffer.from("payload"));
    expect((await refusedPlaintext(sealed.subarray(0, 20))).reason).toBe("invalid");
  });

  test("dropping the final chunk is refused, because the chunk before it is not marked final", async () => {
    const sealed = await sealBytes(randomBytes(SEAL_CHUNK_BYTES + 500));
    const cut = sealed.subarray(0, HEADER_BYTES + FIRST_CHUNK_BYTES);
    expect((await refusedPlaintext(cut)).reason).toBe("invalid");
  });

  test("an early chunk cannot be marked final", async () => {
    const sealed = await sealBytes(randomBytes(SEAL_CHUNK_BYTES + 500));
    changeByte(sealed, HEADER_BYTES, (value) => value | 0x80);
    expect((await refusedPlaintext(sealed)).reason).toBe("invalid");
  });

  test("reordered chunks are refused", async () => {
    const sealed = await sealBytes(randomBytes(2 * SEAL_CHUNK_BYTES + 10));
    const first = sealed.subarray(HEADER_BYTES, HEADER_BYTES + FIRST_CHUNK_BYTES);
    const second = sealed.subarray(HEADER_BYTES + FIRST_CHUNK_BYTES, HEADER_BYTES + 2 * FIRST_CHUNK_BYTES);
    const swapped = Buffer.concat([
      sealed.subarray(0, HEADER_BYTES),
      second,
      first,
      sealed.subarray(HEADER_BYTES + 2 * FIRST_CHUNK_BYTES),
    ]);
    expect((await refusedPlaintext(swapped)).reason).toBe("invalid");
  });

  test("data after the final chunk is refused", async () => {
    const sealed = await sealBytes(randomBytes(100));
    const extended = Buffer.concat([sealed, Buffer.alloc(20)]);
    expect((await refusedPlaintext(extended)).reason).toBe("invalid");
  });

  test("a file that is not a backup is refused as such", async () => {
    const text = Buffer.from("this is a text file, not a MiniBox backup, and it is long enough to read a header");
    expect((await refusedPlaintext(text)).reason).toBe("not_backup");
    expect((await refusedPlaintext(Buffer.alloc(3))).reason).toBe("not_backup");
    expect((await refusedPlaintext(Buffer.alloc(0))).reason).toBe("not_backup");
  });

  test("a header that names an unsupported scrypt cost is refused before any key is derived", async () => {
    const tampered = Buffer.from(await sealBytes(Buffer.from("payload")));
    tampered[9] = 30;
    expect((await refusedPlaintext(tampered)).reason).toBe("invalid");
  });

  test("the writer refuses a scrypt cost outside the supported range", async () => {
    await expect(SealWriter.open(async () => {}, PASSPHRASE, { logN: 40 })).rejects.toThrow(RangeError);
  });
});

async function writeTar(entries: Array<{ name: string; dir?: true; body?: Buffer }>): Promise<Buffer> {
  const parts: Buffer[] = [];
  const writer = new TarWriter(async (bytes) => void parts.push(Buffer.from(bytes)));
  for (const item of entries) {
    if (item.dir) await writer.directory(item.name);
    else {
      const body = item.body ?? Buffer.alloc(0);
      await writer.file(item.name, body.length, pieces(body, 700));
    }
  }
  await writer.close();
  return Buffer.concat(parts);
}

async function readBack(bytes: Buffer): Promise<Map<string, { type: string; body: Buffer }>> {
  const out = new Map<string, { type: string; body: Buffer }>();
  await readTar(new ByteReader(pieces(bytes, 333)), async (item: TarEntry) => {
    const parts: Buffer[] = [];
    if (item.type === "file") for await (const piece of item.content()) parts.push(piece);
    out.set(item.name, { type: item.type, body: Buffer.concat(parts) });
  });
  return out;
}

function tarRefusal(bytes: Buffer): Promise<ArchiveRejected> {
  return refusalOf(readBack(bytes));
}

describe("backup tar", () => {
  test("round-trips directories, files of boundary sizes, long names and unicode names", async () => {
    const long = `${"deep/".repeat(30)}${"x".repeat(60)}.json`;
    const prefixed = `${"d".repeat(90)}/${"e".repeat(90)}/file.bin`;
    const longest = `${"f".repeat(200)}/${"g".repeat(200)}`;
    const files: Array<{ name: string; dir?: true; body?: Buffer }> = [
      { name: "boxes", dir: true },
      { name: "boxes/a.json", body: Buffer.from('{"id":"a"}') },
      { name: "empty.bin", body: Buffer.alloc(0) },
      { name: "b511", body: Buffer.alloc(511, 1) },
      { name: "b512", body: Buffer.alloc(512, 2) },
      { name: "b513", body: Buffer.alloc(513, 3) },
      { name: long, body: Buffer.from("long name") },
      { name: prefixed, body: Buffer.from("prefix split") },
      { name: longest, body: Buffer.from("pax") },
      { name: "数据/文件.json", body: Buffer.from("unicode") },
    ];
    const restored = await readBack(await writeTar(files));
    expect([...restored.keys()]).toEqual(files.map((f) => f.name));
    for (const file of files) {
      const found = restored.get(file.name);
      expect(found?.type).toBe(file.dir ? "dir" : "file");
      expect(found?.body.equals(file.body ?? Buffer.alloc(0))).toBe(true);
    }
  });

  test("checkEntryName accepts plain relative paths and refuses every escape", () => {
    expect(checkEntryName("boxes/a.json")).toBe(true);
    for (const name of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "a/", "a\\b", "a\0b", "a\nb"]) {
      expect(checkEntryName(name)).toBe(false);
    }
  });

  test("the writer refuses a name that is not a plain relative path", async () => {
    const writer = new TarWriter(async () => {});
    await expect(writer.directory("../outside")).rejects.toThrow("refusing");
    await expect(writer.file("/abs", 0, pieces(Buffer.alloc(0)))).rejects.toThrow("refusing");
  });

  test("the writer refuses a body that changes size while it is archived", async () => {
    const writer = new TarWriter(async () => {});
    await expect(writer.file("short", 10, pieces(Buffer.alloc(4)))).rejects.toThrow("changed size");
    await expect(writer.file("long", 2, pieces(Buffer.alloc(4)))).rejects.toThrow("grew");
  });

  test("the reader refuses links, devices and GNU long names", async () => {
    expect((await tarRefusal(archive(entry({ name: "link", type: "2" })))).reason).toBe("invalid");
    expect((await tarRefusal(archive(entry({ name: "hard", type: "1" })))).reason).toBe("invalid");
    expect((await tarRefusal(archive(entry({ name: "dev", type: "3" })))).reason).toBe("invalid");
    const gnu = tarBytes([{ name: "gnu", body: Buffer.from("x"), magic: GNU_MAGIC }]);
    expect((await tarRefusal(gnu)).reason).toBe("invalid");
  });

  test("the reader refuses names that escape the restore folder, or repeat one", async () => {
    const absolute = tarBytes([{ name: "/etc/passwd", body: Buffer.from("x") }]);
    expect((await tarRefusal(absolute)).reason).toBe("invalid");
    const parent = tarBytes([{ name: "../escape", body: Buffer.from("x") }]);
    expect((await tarRefusal(parent)).reason).toBe("invalid");
    const twice = tarBytes([
      { name: "same", body: Buffer.from("1") },
      { name: "same", body: Buffer.from("2") },
    ]);
    expect((await tarRefusal(twice)).message).toContain("twice");
  });

  test("the reader refuses a bad checksum and a body cut short", async () => {
    const bad = tarBytes([{ name: "a", body: Buffer.from("x"), badChecksum: true }]);
    expect((await tarRefusal(bad)).message).toContain("checksum");
    const cut = Buffer.concat([header({ name: "short", type: "0" }, 1000), Buffer.alloc(10, 65)]);
    expect((await tarRefusal(cut)).message).toContain("truncated");
  });

  test("the reader refuses non-zero padding and data after the trailer", async () => {
    const dirtyPadding = Buffer.alloc(502);
    dirtyPadding[0] = 0x41;
    const withBadPadding = Buffer.concat([
      header({ name: "p", type: "0" }, 10),
      Buffer.alloc(10, 65),
      dirtyPadding,
      Buffer.alloc(1024),
    ]);
    expect((await tarRefusal(withBadPadding)).message).toContain("padding");
    const trailing = Buffer.concat([archive(entry({ name: "d", type: "5" })), Buffer.from("junk")]);
    expect((await tarRefusal(trailing)).message).toContain("after its trailer");
  });

  test("the reader refuses an archive without a trailer, and a PAX key it does not use", async () => {
    const untrailed = entry({ name: "d", type: "5" });
    expect((await tarRefusal(untrailed)).message).toContain("without its trailer");
    const withLinkpath = archive(paxEntry({ linkpath: "/etc/x" }), entry({ name: "d", type: "0" }));
    expect((await tarRefusal(withLinkpath)).message).toContain("linkpath");
  });

  test("the reader refuses a directory that carries a body", async () => {
    const withBody = archive(entry({ name: "dir", type: "5" }, Buffer.from("oops")));
    expect((await tarRefusal(withBody)).message).toContain("directory");
  });
});
