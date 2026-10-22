import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import { firstEntryOwner, readFirstEntryOwner, secretsArchive } from "../src/docker/archive";
import { parseTar } from "../src/services/files-tar";
import { archive, entry, gnuLongName, header, paxEntry, paxGlobal, seal } from "./support/tar";

const root = (uid: number, gid: number) => entry({ name: "workspace/", type: "5", uid, gid });

describe("firstEntryOwner", () => {
  test("reads the owner of the first ustar entry, which is the directory that was asked for", () => {
    expect(firstEntryOwner(archive(root(1000, 1000), entry({ name: "workspace/seed", type: "0" })))).toEqual({
      uid: 1000,
      gid: 1000,
    });
    expect(firstEntryOwner(archive(root(0, 0)))).toEqual({ uid: 0, gid: 0 });
  });

  test("a PAX record in front of the entry supplies uid and gid, which ustar cannot hold", () => {
    const bytes = archive(paxEntry({ uid: "3000000", gid: "3000001" }), root(0, 0));
    expect(firstEntryOwner(bytes)).toEqual({ uid: 3000000, gid: 3000001 });
  });

  test("a PAX record overrides the ustar fields, and records it does not name leave them alone", () => {
    const bytes = archive(paxEntry({ uid: "1001", mtime: "1729504860.5" }), root(7, 1000));
    expect(firstEntryOwner(bytes)).toEqual({ uid: 1001, gid: 1000 });
  });

  test("a GNU long name is skipped, so the owner of its own header is not used", () => {
    const bytes = archive(gnuLongName("workspace/a/very/long/name"), root(1000, 1000));
    expect(firstEntryOwner(bytes)).toEqual({ uid: 1000, gid: 1000 });
  });

  test("a PAX record in front of a GNU long name still applies to the entry after it", () => {
    const bytes = archive(paxEntry({ uid: "1001" }), gnuLongName("workspace/a/very/long/name"), root(7, 1000));
    expect(firstEntryOwner(bytes)).toEqual({ uid: 1001, gid: 1000 });
  });

  test("a PAX global record applies to the entry unless a per-entry record names the same id", () => {
    expect(firstEntryOwner(archive(paxGlobal({ uid: "42", gid: "43" }), root(0, 0)))).toEqual({ uid: 42, gid: 43 });
    const overridden = archive(paxGlobal({ uid: "42", gid: "43" }), paxEntry({ uid: "44" }), root(0, 0));
    expect(firstEntryOwner(overridden)).toEqual({ uid: 44, gid: 43 });
  });

  test("only the header of the first entry is needed, not its data", () => {
    const file = header({ name: "workspace/big", type: "0", uid: 1000, gid: 1000 }, 10_000_000);
    expect(firstEntryOwner(file)).toEqual({ uid: 1000, gid: 1000 });
  });

  test("bytes that end inside the header or a PAX record are not an answer yet", () => {
    const bytes = archive(paxEntry({ uid: "3000000", gid: "3000001" }), root(0, 0));
    expect(firstEntryOwner(bytes.subarray(0, 300))).toBeNull();
    expect(firstEntryOwner(bytes.subarray(0, 1000))).toBeNull();
  });

  test("an archive that is empty has no entry", () => {
    expect(() => firstEntryOwner(archive())).toThrow("the archive ends before its first entry");
  });

  test("a numeric field that is not octal is an error", () => {
    const block = header({ name: "workspace/", uid: 1000 });
    block.write("zzzzzzz\0", 108, "ascii");
    expect(() => firstEntryOwner(seal(block))).toThrow('invalid numeric field "zzzzzzz"');
  });

  test("a malformed PAX record is an error", () => {
    expect(() =>
      firstEntryOwner(archive(entry({ name: "PaxHeaders.0", type: "x" }, Buffer.from("uid=1000\n")))),
    ).toThrow("a PAX record is malformed");
  });

  test("an id beyond the largest one chown accepts is an error", () => {
    expect(() => firstEntryOwner(archive(paxEntry({ uid: "4294967295" }), root(0, 0)))).toThrow("out of range");
  });

  test("a base-256 ustar uid is decoded", () => {
    const block = root(0, 0);
    block.fill(0, 108, 116);
    block[108] = 0x80;
    block.writeUInt32BE(3000000, 112);
    expect(firstEntryOwner(archive(seal(block)))).toEqual({ uid: 3000000, gid: 0 });
  });

  test("a record that claims more bytes than the archive limit is refused", () => {
    const oversized = header({ name: "PaxHeaders.0", type: "x" }, 4 * 1024 * 1024);
    expect(() => firstEntryOwner(oversized)).toThrow("a tar record is too large");
  });
});

describe("readFirstEntryOwner", () => {
  test("reads the owner from a stream that delivers the archive in small chunks", async () => {
    const bytes = archive(paxEntry({ uid: "3000000", gid: "3000001" }), root(0, 0));
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 100) chunks.push(bytes.subarray(at, at + 100));
    expect(await readFirstEntryOwner(Readable.from(chunks))).toEqual({ uid: 3000000, gid: 3000001 });
  });

  test("stops the stream once the entry's header is in, instead of reading a whole directory", async () => {
    let pulled = 0;
    async function* body() {
      pulled += 1;
      yield root(1000, 1000);
      for (let i = 0; i < 10_000; i++) {
        pulled += 1;
        yield Buffer.alloc(64 * 1024);
      }
    }
    const stream = Readable.from(body());
    expect(await readFirstEntryOwner(stream)).toEqual({ uid: 1000, gid: 1000 });
    expect(stream.destroyed).toBe(true);
    expect(pulled).toBeLessThan(100);
  });

  test("a stream that ends before any entry rejects, and is destroyed", async () => {
    const stream = Readable.from([Buffer.alloc(100)]);
    await expect(readFirstEntryOwner(stream)).rejects.toThrow("the archive ends before its first entry");
    expect(stream.destroyed).toBe(true);
  });
});

describe("secretsArchive", () => {
  test("writes each secret as a root-only regular file, in an archive that parses back exactly", () => {
    const bytes = secretsArchive([
      { name: "repo.key", value: "a".repeat(64) },
      { name: "other", value: "multi\nline" },
    ]);
    const entries = parseTar(bytes);
    expect(entries.map(({ name, type, uid, gid, size }) => ({ name, type, uid, gid, size }))).toEqual([
      { name: "repo.key", type: "file", uid: 0, gid: 0, size: 64 },
      { name: "other", type: "file", uid: 0, gid: 0, size: 10 },
    ]);
    expect(bytes.subarray(100, 108).toString("ascii")).toBe("0000400\0");
    expect(bytes.subarray(1024 + 100, 1024 + 108).toString("ascii")).toBe("0000400\0");
    expect(entries[0]?.data.toString("utf8")).toBe("a".repeat(64));
    expect(entries[1]?.data.toString("utf8")).toBe("multi\nline");
    expect(bytes.length % 512).toBe(0);
  });

  test("a name that could leave the directory is refused, and an empty list is an empty archive", () => {
    expect(() => secretsArchive([{ name: "../escape", value: "x" }])).toThrow("not a secret file name");
    expect(() => secretsArchive([{ name: "a/b", value: "x" }])).toThrow("not a secret file name");
    expect(parseTar(secretsArchive([]))).toEqual([]);
  });
});
