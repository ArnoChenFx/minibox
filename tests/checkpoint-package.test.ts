import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  MAX_ENTRY_BYTES,
  newPackageId,
  PackageRejected,
  PackageScanner,
  type ScanLimits,
  parseManifest,
} from "../src/checkpoints/package";
import { type TarEntry, tarBytes } from "./support/tar";

const PACK = `ab${"0".repeat(62)}`;
const SNAPSHOT = "c".repeat(64);
const KEY = "d".repeat(64);

function repository(): TarEntry[] {
  return [
    { name: "repo/", dir: true },
    { name: "repo/config", body: Buffer.from('{"version":2}') },
    { name: "repo/data/", dir: true },
    { name: "repo/data/ab/", dir: true },
    { name: `repo/data/ab/${PACK}`, body: Buffer.alloc(300, 7) },
    { name: "repo/snapshots/", dir: true },
    { name: `repo/snapshots/${SNAPSHOT}`, body: Buffer.from("{}") },
    { name: "repo/keys/", dir: true },
    { name: `repo/keys/${KEY}`, body: Buffer.from("{}") },
    { name: "repo/locks/", dir: true },
    { name: "repo/index/", dir: true },
  ];
}

function scan(bytes: Buffer, limits?: Partial<ScanLimits>) {
  const scanner = new PackageScanner(limits);
  scanner.push(bytes);
  return scanner.end();
}

function refusal(bytes: Buffer, limits?: Partial<ScanLimits>): PackageRejected {
  try {
    scan(bytes, limits);
  } catch (e) {
    if (e instanceof PackageRejected) return e;
    throw e;
  }
  throw new Error("the package was accepted");
}

describe("PackageScanner accepts what restic writes", () => {
  test("a repository with directory entries and a trailer", () => {
    const bytes = tarBytes(repository());
    expect(scan(bytes)).toEqual({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  });

  test("the same bytes in small chunks give the same digest", () => {
    const bytes = tarBytes(repository());
    const scanner = new PackageScanner();
    for (let offset = 0; offset < bytes.length; offset += 7) scanner.push(bytes.subarray(offset, offset + 7));
    expect(scanner.end()).toEqual(scan(bytes));
  });

  test("PAX timestamps are allowed, PAX paths are not", () => {
    const entries = repository();
    entries[1] = { name: "repo/config", body: Buffer.from("{}"), pax: { mtime: "1700000000.5" } };
    expect(scan(tarBytes(entries)).bytes).toBeGreaterThan(0);
    entries[1] = { name: "repo/config", body: Buffer.from("{}"), pax: { path: "repo/keys/evil" } };
    expect(refusal(tarBytes(entries)).message).toContain("path");
  });

  test("GNU magic is accepted, and its prefix field is ignored", () => {
    const entries = repository();
    entries[1] = {
      name: "repo/config",
      prefix: "junk",
      body: Buffer.from("{}"),
      magic: Buffer.from("ustar  \u0000", "latin1"),
    };
    expect(scan(tarBytes(entries)).bytes).toBeGreaterThan(0);
  });
});

describe("PackageScanner refuses hostile archives", () => {
  const cases: [string, () => Buffer, RegExp?][] = [
    ["a symlink", () => tarBytes([...repository(), { name: "repo/link", typeflag: "2", linkname: "/etc/passwd" }])],
    ["a hard link", () => tarBytes([...repository(), { name: "repo/link", typeflag: "1", linkname: "repo/config" }])],
    ["a device", () => tarBytes([...repository(), { name: "repo/dev", typeflag: "3" }])],
    [
      "a GNU long name",
      () => tarBytes([...repository(), { name: "././@LongLink", typeflag: "L", body: Buffer.from("x") }]),
    ],
    ["a global PAX header", () => tarBytes([{ name: "pax", typeflag: "g", body: Buffer.from("") }, ...repository()])],
    ["a traversal name", () => tarBytes([...repository(), { name: "repo/../../etc/passwd", body: Buffer.from("x") }])],
    ["an absolute name", () => tarBytes([...repository(), { name: "/etc/passwd", body: Buffer.from("x") }])],
    ["a name outside the layout", () => tarBytes([...repository(), { name: "repo/other", body: Buffer.from("x") }])],
    [
      "a pack in the wrong bucket",
      () => tarBytes([...repository(), { name: `repo/data/cd/${PACK}`, body: Buffer.from("x") }]),
    ],
    [
      "a setuid file",
      () => tarBytes([...repository(), { name: "repo/locks/" + "e".repeat(64), body: Buffer.from("x"), mode: 0o4755 }]),
    ],
    ["a sticky directory", () => tarBytes([...repository(), { name: "repo/tmp/", dir: true, mode: 0o1777 }])],
    [
      "a directory with a body",
      () => tarBytes([...repository(), { name: "repo/index/", dir: true, body: Buffer.from("x") }]),
    ],
    [
      "a file with a trailing slash",
      () => tarBytes([...repository(), { name: `repo/keys/${"e".repeat(64)}/`, body: Buffer.from("x") }]),
    ],
    ["a duplicate entry", () => tarBytes([...repository(), { name: "repo/config", body: Buffer.from("again") }])],
    [
      "a bad header checksum",
      () =>
        tarBytes([...repository(), { name: "repo/keys/" + "f".repeat(64), body: Buffer.from("x"), badChecksum: true }]),
    ],
    [
      "a non-USTAR header",
      () =>
        tarBytes([
          ...repository(),
          { name: "repo/keys/" + "f".repeat(64), body: Buffer.from("x"), magic: Buffer.alloc(8) },
        ]),
    ],
    [
      "a PAX header followed by nothing",
      () => tarBytes([...repository(), { name: "x", typeflag: "x", body: Buffer.from("") }]),
    ],
    [
      "a PAX xattr",
      () =>
        tarBytes([
          ...repository(),
          {
            name: "repo/keys/" + "f".repeat(64),
            body: Buffer.from("x"),
            pax: { "SCHILY.xattr.security.capability": "x" },
          },
        ]),
    ],
    [
      "a PAX size override",
      () =>
        tarBytes([
          ...repository(),
          { name: "repo/keys/" + "f".repeat(64), body: Buffer.from("x"), pax: { size: "0" } },
        ]),
    ],
    ["no repository config", () => tarBytes(repository().filter((entry) => entry.name !== "repo/config"))],
    ["no end marker", () => tarBytes(repository(), { trailer: false })],
    ["one zero block only", () => Buffer.concat([tarBytes(repository(), { trailer: false }), Buffer.alloc(512)])],
    ["data after the trailer", () => Buffer.concat([tarBytes(repository()), Buffer.from("junk".repeat(128))])],
    ["a truncated body", () => tarBytes(repository()).subarray(0, 2048)],
    ["a truncated header", () => tarBytes(repository()).subarray(0, 1000)],
  ];

  for (const [name, build, pattern] of cases) {
    test(name, () => {
      const bytes = build();
      const rejected = refusal(bytes);
      expect(rejected.reason === "invalid" || rejected.reason === "not_package").toBe(true);
      if (pattern) expect(rejected.message).toMatch(pattern);
    });
  }

  test("a file over the entry limit is refused", () => {
    const bytes = tarBytes([...repository(), { name: "repo/locks/" + "e".repeat(64), body: Buffer.alloc(64) }]);
    expect(refusal(bytes, { maxEntryBytes: 32 }).message).toContain("larger than the limit");
  });

  test("too many entries are refused", () => {
    expect(refusal(tarBytes(repository()), { maxEntries: 3 }).message).toContain("too many entries");
  });

  test("a missing config is reported as not a package", () => {
    const bytes = tarBytes(repository().filter((entry) => entry.name !== "repo/config"));
    expect(refusal(bytes).reason).toBe("not_package");
  });

  test("the default entry limit is the documented 256 MiB", () => {
    expect(MAX_ENTRY_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe("manifest and package ids", () => {
  const manifest = {
    version: 1,
    id: "ck_0123456789abcdef",
    boxId: "bx_01",
    boxName: "demo",
    label: "demo",
    reason: "",
    pinned: false,
    consistency: "live",
    specRevision: 3,
    spec: {
      template: { ref: "base", image: "minibox-template:base", digest: null },
      cpus: 2,
      memoryBytes: 1024,
      profile: "standard",
    },
    data: [
      {
        volumeId: "vol_1",
        path: "/home/dev",
        mode: "rw",
        role: "home",
        ownership: "owned",
        owner: { uid: 1000, gid: 1000 },
        bytes: 12,
      },
    ],
    createdAt: "2026-10-01T00:00:00.000Z",
  };

  test("a valid manifest parses", () => {
    expect(parseManifest(JSON.stringify(manifest)).id).toBe(manifest.id);
  });

  test("unknown keys, host fields and bad ids are refused", () => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, hostId: "local" }))).toThrow(PackageRejected);
    expect(() => parseManifest(JSON.stringify({ ...manifest, id: "../escape" }))).toThrow(PackageRejected);
    expect(() => parseManifest(JSON.stringify({ ...manifest, data: [] }))).toThrow(PackageRejected);
    expect(() => parseManifest("not json")).toThrow(PackageRejected);
  });

  test("a path that climbs out of the mount is refused", () => {
    const data = [{ ...manifest.data[0], path: "/home/../etc" }];
    expect(() => parseManifest(JSON.stringify({ ...manifest, data }))).toThrow(PackageRejected);
  });

  test("package ids have the pk_ prefix and are unique", () => {
    const first = newPackageId();
    expect(first).toMatch(/^pk_[0-9a-z]{16}$/);
    expect(newPackageId()).not.toBe(first);
  });
});
