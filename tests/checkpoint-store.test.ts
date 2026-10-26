import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCheckpointId, newCheckpointId } from "../src/checkpoints/id";
import { CheckpointStore } from "../src/checkpoints/store";
import {
  CHECKPOINT_VERSION,
  type CheckpointRecord,
  type PendingRollback,
  ROLLBACK_VERSION,
} from "../src/checkpoints/types";
import { newBoxId } from "../src/specs/revision";
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
    data: [
      {
        volumeId: "vol_abcdefgh1234",
        path: "/workspace",
        mode: "rw",
        role: "workspace",
        ownership: "owned",
        owner: { uid: 1000, gid: 1000 },
        snapshotId: "a1b2c3d4",
        bytes: 12,
      },
    ],
    system: null,
    trash: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

function pendingOf(boxId: string, overrides: Partial<PendingRollback> = {}): PendingRollback {
  return {
    version: ROLLBACK_VERSION,
    hostId: "local",
    boxId,
    boxName: "dev",
    checkpointId: newCheckpointId(),
    checkpointLabel: "before refactor",
    safetyCheckpointId: newCheckpointId(),
    createdBy: "owner",
    createdAt: "2026-10-21T00:00:00.000Z",
    replaced: [
      { volumeId: "vol_abcdefgh1234", name: "dev-workspace", engineName: "mbtest-dev-workspace", path: "/workspace" },
    ],
    restored: [
      {
        volumeId: "vol_ijklmnop5678",
        name: "dev-workspace-2",
        engineName: "mbtest-dev-workspace-2",
        path: "/workspace",
      },
    ],
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

  test("a pending rollback round-trips through a file only its owner can read, and is listed until it is removed", () => {
    const { store, dataDir } = freshStore();
    const boxId = newBoxId();
    const pending = pendingOf(boxId);

    store.writePendingRollback(pending);

    expect(store.pendingRollback(boxId)).toEqual(pending);
    expect(store.pendingRollbacks()).toEqual([pending]);
    expect(statSync(join(dataDir, "checkpoints", "rollbacks", `${boxId}.json`)).mode & 0o777).toBe(0o600);
    store.removePendingRollback(boxId);
    expect(store.pendingRollback(boxId)).toBeNull();
    expect(store.pendingRollbacks()).toEqual([]);
  });

  test("a second write for a box replaces the first, since a box has at most one pending rollback", () => {
    const { store } = freshStore();
    const boxId = newBoxId();
    store.writePendingRollback(pendingOf(boxId));
    const next = pendingOf(boxId, { boxName: "renamed" });

    store.writePendingRollback(next);

    expect(store.pendingRollbacks()).toEqual([next]);
  });

  test("a corrupt rollback file is skipped and left in place, so nothing is deleted", () => {
    const { store, dataDir } = freshStore();
    const boxId = newBoxId();
    store.writePendingRollback(pendingOf(boxId));
    const path = join(dataDir, "checkpoints", "rollbacks", `${boxId}.json`);
    writeFileSync(path, "{not json");
    const restore = silenceLogs();
    try {
      expect(store.pendingRollback(boxId)).toBeNull();
      expect(store.pendingRollbacks()).toEqual([]);
    } finally {
      restore();
    }
    expect(existsSync(path)).toBe(true);
  });

  for (const [field, value] of [
    ["replaced", [null]],
    ["restored", [null]],
    ["replaced", [{ volumeId: "vol_bad", name: "incomplete", path: "/workspace" }]],
    ["restored", [{ volumeId: "vol_bad", name: "bad-path", engineName: "bad", path: null }]],
    ["boxName", null],
    ["checkpointLabel", 123],
    ["createdAt", null],
    ["createdBy", {}],
  ] as const) {
    test(`a malformed ${field} is skipped without hiding a valid rollback or rewriting either file`, () => {
      const { store } = freshStore();
      const good = pendingOf(newBoxId(), { createdBy: null });
      const bad = pendingOf(newBoxId());
      store.writePendingRollback(good);
      store.writePendingRollback(bad);
      const path = join(store.rollbackDir(), `${bad.boxId}.json`);
      const saved = JSON.stringify({ ...bad, [field]: value });
      writeFileSync(path, saved);
      const restore = silenceLogs();
      try {
        expect(store.pendingRollback(bad.boxId)).toBeNull();
        expect(store.pendingRollbacks()).toEqual([good]);
        expect(readFileSync(path, "utf8")).toBe(saved);
      } finally {
        restore();
      }
    });
  }

  test("a rollback record that cannot be read does not fail the other records", () => {
    const { store } = freshStore();
    const good = pendingOf(newBoxId());
    const bad = pendingOf(newBoxId());
    store.writePendingRollback(good);
    store.writePendingRollback(bad);
    const path = join(store.rollbackDir(), `${bad.boxId}.json`);
    unlinkSync(path);
    mkdirSync(path);
    const restore = silenceLogs();
    try {
      expect(store.pendingRollback(bad.boxId)).toBeNull();
      expect(store.pendingRollbacks()).toEqual([good]);
      expect(statSync(path).isDirectory()).toBe(true);
    } finally {
      restore();
    }
  });

  test("a box id that is not a box id never reaches the filesystem, and a missing rollback lists nothing", () => {
    const { store } = freshStore();
    expect(store.pendingRollback("../escape")).toBeNull();
    expect(() => store.writePendingRollback(pendingOf("../escape"))).toThrow();
    expect(() => store.removePendingRollback("../escape")).not.toThrow();
    expect(store.pendingRollbacks()).toEqual([]);
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
