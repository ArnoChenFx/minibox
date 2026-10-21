import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCheckpointId, newCheckpointId } from "../src/checkpoints/id";
import { CheckpointStore } from "../src/checkpoints/store";
import { CHECKPOINT_VERSION, type CheckpointRecord } from "../src/checkpoints/types";
import { silenceLogs } from "./support/app";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshStore(): { store: CheckpointStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "mb-checkpoint-store-"));
  roots.push(dataDir);
  return { store: new CheckpointStore(dataDir), dataDir };
}

function record(id: string, overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    version: CHECKPOINT_VERSION,
    id,
    hostId: "local",
    boxId: "bx_abcdefgh1234",
    boxName: "dev",
    label: "before refactor",
    reason: "",
    createdBy: "owner",
    pinned: false,
    auto: false,
    consistency: "live",
    specRevision: 3,
    spec: {
      template: { ref: "dev", image: "minibox-template:base", digest: null },
      cpus: 1,
      memoryBytes: 512 * 1024 * 1024,
      profile: null,
    },
    data: [{ volumeId: "vol_abcdefgh1234", path: "/workspace", role: "workspace", snapshotId: "a1b2c3d4", bytes: 12 }],
    system: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkpoint ids", () => {
  test("new ids are well formed, and anything else is refused", () => {
    expect(isCheckpointId(newCheckpointId())).toBe(true);
    expect(isCheckpointId("ck_")).toBe(false);
    expect(isCheckpointId("vol_abcdefgh1234")).toBe(false);
    expect(isCheckpointId("ck_../../etc")).toBe(false);
  });
});

describe("CheckpointStore", () => {
  test("a record round-trips through a file that only its owner can read", () => {
    const { store } = freshStore();
    const id = store.allocateId();
    store.write(record(id));
    expect(store.read(id)).toEqual(record(id));
    expect(statSync(store.pathFor(id)).mode & 0o777).toBe(0o600);
  });

  test("listing returns the well-formed records and skips corrupt or foreign files", () => {
    const { store, dataDir } = freshStore();
    const good = store.allocateId();
    store.write(record(good));
    const corrupt = "ck_zzzzzzzz1234";
    writeFileSync(join(dataDir, "checkpoints", `${corrupt}.json`), "{not json");
    writeFileSync(join(dataDir, "checkpoints", "ck_yyyyyyyy5678.json"), JSON.stringify({ version: 99 }));
    writeFileSync(join(dataDir, "checkpoints", "notes.txt"), "hello");
    const restore = silenceLogs();
    try {
      expect(store.list().map((r) => r.id)).toEqual([good]);
      expect(store.read(corrupt)).toBeNull();
    } finally {
      restore();
    }
  });

  test("a missing directory lists nothing, and removing an absent record is quiet", () => {
    const { store } = freshStore();
    expect(store.list()).toEqual([]);
    const id = store.allocateId();
    store.remove(id);
    expect(store.read(id)).toBeNull();
  });

  test("removing a record deletes its file", () => {
    const { store } = freshStore();
    const id = store.allocateId();
    store.write(record(id));
    store.remove(id);
    expect(store.read(id)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("ids that are not checkpoint ids never reach the filesystem", () => {
    const { store } = freshStore();
    expect(store.read("../../etc/passwd")).toBeNull();
    expect(() => store.pathFor("../escape")).toThrow();
  });

  test("mutations queued with exclusive run one after another", async () => {
    const { store } = freshStore();
    const order: string[] = [];
    const slow = store.exclusive(async () => {
      order.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow:end");
    });
    const fast = store.exclusive(async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow:start", "slow:end", "fast"]);
  });

  test("a failed mutation does not block the ones queued after it", async () => {
    const { store } = freshStore();
    const failed = store.exclusive(async () => {
      throw new Error("boom");
    });
    const next = store.exclusive(async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ran");
  });
});
