import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VolumeStore } from "../src/volumes/store";
import type { VolumeRecord } from "../src/volumes/types";

let dataDir: string;
let store: VolumeStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mbx-volstore-"));
  store = new VolumeStore(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function record(id: string, engineName: string, name = engineName): VolumeRecord {
  const now = new Date(0).toISOString();
  return {
    version: 1,
    id,
    name,
    hostId: "local",
    pool: "local",
    role: null,
    ownership: "independent",
    ownerBoxId: null,
    sensitive: false,
    checkpoint: true,
    engineName,
    subpath: null,
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
    bytes: null,
    bytesAt: null,
    limits: { softBytes: null, hardBytes: null, action: "warn" },
  };
}

describe("the volume store's in-memory snapshot", () => {
  test("a write or remove through the store is seen by the next lookup", () => {
    expect(store.findByEngine("local", "vol_aaaaaaaa")).toBeNull();
    store.write(record("vol_aaaaaaaa", "vol_aaaaaaaa", "first"));
    expect(store.findByEngine("local", "vol_aaaaaaaa")?.name).toBe("first");

    store.write({ ...record("vol_aaaaaaaa", "vol_aaaaaaaa"), name: "renamed" });
    expect(store.read("vol_aaaaaaaa")?.name).toBe("renamed");
    expect(store.resolve("renamed", "local")?.id).toBe("vol_aaaaaaaa");

    store.remove("vol_aaaaaaaa");
    expect(store.read("vol_aaaaaaaa")).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("repeated lookups do not read the record files again while the directory is unchanged", () => {
    store.write(record("vol_bbbbbbbb", "vol_bbbbbbbb", "kept"));
    expect(store.findByEngine("local", "vol_bbbbbbbb")?.name).toBe("kept");

    // Rewriting a file in place leaves the directory's mtime alone, so a store that re-read on every lookup would see
    // the corrupt file and drop the record. The snapshot keeps answering from memory.
    writeFileSync(store.pathFor("vol_bbbbbbbb"), "not json");
    for (let i = 0; i < 3; i++) expect(store.findByEngine("local", "vol_bbbbbbbb")?.name).toBe("kept");
  });

  test("a record another writer renames into the directory is picked up", () => {
    store.write(record("vol_cccccccc", "vol_cccccccc"));
    expect(store.list()).toHaveLength(1);

    // Directory mtimes tick at the kernel's clock granularity, so let it move past the snapshot's stamp first.
    Bun.sleepSync(25);
    const temp = join(dataDir, "incoming.tmp");
    writeFileSync(temp, JSON.stringify(record("vol_dddddddd", "legacy-name")));
    renameSync(temp, store.pathFor("vol_dddddddd"));
    expect(store.findByEngine("local", "legacy-name")?.id).toBe("vol_dddddddd");
    expect(
      store
        .list()
        .map((item) => item.id)
        .toSorted(),
    ).toEqual(["vol_cccccccc", "vol_dddddddd"]);
  });

  test("records handed out are frozen, so a caller cannot change the shared copy", () => {
    store.write(record("vol_eeeeeeee", "vol_eeeeeeee", "frozen"));
    const found = store.read("vol_eeeeeeee");
    expect(Object.isFrozen(found)).toBe(true);
    expect(() => {
      (found as VolumeRecord).name = "changed";
    }).toThrow();
    expect(store.read("vol_eeeeeeee")?.name).toBe("frozen");
  });

  test("a missing volumes directory lists nothing", () => {
    expect(store.list()).toEqual([]);
    expect(store.read("vol_ffffffff")).toBeNull();
  });
});
