import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { capacityStateOf, type CheckpointPolicy, expiredAutomatic } from "../src/checkpoints/policy";
import { CHECKPOINT_VERSION, type CheckpointRecord } from "../src/checkpoints/types";
import type { Config } from "../src/config";
import type { HostMetrics } from "../src/host/metrics";
import type { HostCtx } from "../src/host/registry";
import * as boxes from "../src/services/boxes";
import { assertAutomaticAllowed, usageOf } from "../src/services/checkpoint-capacity";
import { applyRetention, CheckpointSweep } from "../src/services/checkpoint-retention";
import { type CheckpointView, rollbackBox, takeCheckpoint } from "../src/services/checkpoints";
import { confirmRollback } from "../src/services/rollback";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";
import { call, finishedTask, mint, refused, type Harness, startHarness } from "./support/tokens";

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = Date.parse("2026-10-21T00:00:00.000Z");
const daysBefore = (days: number, from = NOW): string => new Date(from - days * DAY).toISOString();

function recordOf(id: string, overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    version: CHECKPOINT_VERSION,
    id,
    hostId: "local",
    boxId: "bx_alpha",
    boxName: "alpha",
    label: id,
    reason: "",
    createdBy: "owner",
    pinned: false,
    auto: true,
    consistency: "live",
    specRevision: 1,
    spec: { template: { ref: "base", image: "base", digest: null }, cpus: 1, memoryBytes: MB, profile: null },
    data: [],
    system: null,
    trash: null,
    createdAt: daysBefore(0, NOW),
    updatedAt: daysBefore(0, NOW),
    ...overrides,
  };
}

const idsOf = (records: CheckpointRecord[]): string[] => records.map((record) => record.id);

describe("which automatic checkpoints expire", () => {
  const policy: CheckpointPolicy = { keepLast: 2, keepDays: 30, capacityBytes: 0, trashKeepDays: 7 };
  const none = new Set<string>();

  test("the newest keepLast of each box stay, and the older ones go", () => {
    const records = [
      recordOf("ck_a1", { createdAt: daysBefore(1, NOW) }),
      recordOf("ck_a2", { createdAt: daysBefore(2, NOW) }),
      recordOf("ck_a3", { createdAt: daysBefore(3, NOW) }),
      recordOf("ck_b1", { boxId: "bx_beta", createdAt: daysBefore(4, NOW) }),
    ];
    const expired = expiredAutomatic(records, { ...policy, keepLast: 2, keepDays: 0 }, NOW, none);
    expect(idsOf(expired)).toEqual(["ck_a3"]);
  });

  test("an automatic checkpoint older than keepDays goes even when it is among the newest", () => {
    const records = [
      recordOf("ck_new", { createdAt: daysBefore(1, NOW) }),
      recordOf("ck_old", { createdAt: daysBefore(8, NOW) }),
    ];
    expect(idsOf(expiredAutomatic(records, { ...policy, keepLast: 20, keepDays: 7 }, NOW, none))).toEqual(["ck_old"]);
  });

  test("keepDays of 0 keeps automatic checkpoints whatever their age", () => {
    const records = [recordOf("ck_ancient", { createdAt: daysBefore(4000, NOW) })];
    expect(expiredAutomatic(records, { ...policy, keepLast: 20, keepDays: 0 }, NOW, none)).toEqual([]);
  });

  test("manual and pinned checkpoints never expire, whatever their age", () => {
    const records = [
      recordOf("ck_manual", { auto: false, createdAt: daysBefore(900, NOW) }),
      recordOf("ck_pinned", { pinned: true, createdAt: daysBefore(900, NOW) }),
    ];
    expect(
      expiredAutomatic(records, { keepLast: 1, keepDays: 1, capacityBytes: 0, trashKeepDays: 7 }, NOW, none),
    ).toEqual([]);
  });

  test("pinned checkpoints do not count toward keepLast", () => {
    const records = [
      recordOf("ck_pinned", { pinned: true, createdAt: daysBefore(0, NOW) }),
      recordOf("ck_newest", { createdAt: daysBefore(1, NOW) }),
      recordOf("ck_older", { createdAt: daysBefore(2, NOW) }),
    ];
    expect(
      idsOf(expiredAutomatic(records, { keepLast: 1, keepDays: 0, capacityBytes: 0, trashKeepDays: 7 }, NOW, none)),
    ).toEqual(["ck_older"]);
  });

  test("a held checkpoint stays whatever its rank or age, and still takes a place among the newest", () => {
    const records = [
      recordOf("ck_held", { createdAt: daysBefore(1, NOW) }),
      recordOf("ck_older", { createdAt: daysBefore(2, NOW) }),
    ];
    const held = new Set(["ck_held"]);
    expect(
      idsOf(expiredAutomatic(records, { keepLast: 1, keepDays: 0, capacityBytes: 0, trashKeepDays: 7 }, NOW, held)),
    ).toEqual(["ck_older"]);
    const old = [recordOf("ck_held", { createdAt: daysBefore(400, NOW) })];
    expect(expiredAutomatic(old, { keepLast: 1, keepDays: 7, capacityBytes: 0, trashKeepDays: 7 }, NOW, held)).toEqual(
      [],
    );
  });
});

describe("capacity states", () => {
  test("no limit is unlimited, and a limit reads ok, then warning from 80 percent, then exceeded", () => {
    expect(capacityStateOf(10 * 1024 * MB, 0)).toBe("unlimited");
    expect(capacityStateOf(79, 100)).toBe("ok");
    expect(capacityStateOf(80, 100)).toBe("warning");
    expect(capacityStateOf(99, 100)).toBe("warning");
    expect(capacityStateOf(100, 100)).toBe("exceeded");
  });
});

let runtime: FakeRuntime;
let engine: FakeCheckpointEngine;
let host: HostCtx;
let app: ReturnType<typeof createTestApp>["app"];
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

function setup(overrides: Partial<Config> = {}): void {
  const created = createTestApp({ labelPrefix: "mbtest", ...overrides });
  runtime = created.runtime;
  engine = created.checkpoints;
  app = created.app;
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true" });
}

const take = (ref: string): Promise<CheckpointView> =>
  takeCheckpoint(host, ref, { pinned: false, include: { system: false, volumes: [] }, consistency: "live" }, "owner");

const makeBox = (name: string) => boxes.createBox(host, { name, cpus: 1, memoryMb: 512, createdBy: "owner" });

/** Rewrites a checkpoint as an automatic one taken `days` ago, so retention sees it as an old safety point. */
function ageAutomatic(id: string, days: number): void {
  const record = host.checkpoints.read(id);
  if (!record) throw new Error(`no checkpoint ${id}`);
  host.checkpoints.write({ ...record, auto: true, createdAt: daysBefore(days) });
}

describe("applying retention to a real store", () => {
  beforeEach(() => setup({ checkpointKeepLast: 1, checkpointKeepDays: 0 }));

  test("removes the automatic checkpoints the policy drops, and forgets their snapshots", async () => {
    const box = await makeBox("alpha");
    const first = await take(box.boxId);
    const second = await take(box.boxId);
    const third = await take(box.boxId);
    ageAutomatic(first.id, 3);
    ageAutomatic(second.id, 2);
    ageAutomatic(third.id, 1);

    const removed = await applyRetention(host);

    expect(removed.toSorted()).toEqual([first.id, second.id].toSorted());
    expect(host.checkpoints.read(third.id)).not.toBeNull();
    expect(host.checkpoints.read(first.id)).toBeNull();
    expect(engine.snapshots.size).toBe(third.data.length);
  });

  test("a checkpoint the engine cannot forget stays and is logged, and the others are still removed", async () => {
    const box = await makeBox("alpha");
    const stuck = await take(box.boxId);
    const gone = await take(box.boxId);
    const kept = await take(box.boxId);
    ageAutomatic(stuck.id, 3);
    ageAutomatic(gone.id, 2);
    ageAutomatic(kept.id, 1);
    const [layer] = stuck.data;
    if (!layer) throw new Error("the checkpoint has no data");
    engine.snapshots.delete(layer.snapshotId);

    const removed = await applyRetention(host);

    expect(removed).toEqual([gone.id]);
    expect(host.checkpoints.read(stuck.id)).not.toBeNull();
    expect(host.checkpoints.read(kept.id)).not.toBeNull();
  });

  test("the sweep reports how many checkpoints it removed, and a host with none does nothing", async () => {
    const sweep = new CheckpointSweep(app.hosts);
    expect(await sweep.run()).toBe(0);

    const box = await makeBox("alpha");
    const old = await take(box.boxId);
    const newer = await take(box.boxId);
    ageAutomatic(old.id, 3);
    ageAutomatic(newer.id, 1);

    expect(await sweep.run()).toBe(1);
    expect(host.checkpoints.read(old.id)).toBeNull();
  });
});

describe("the safety checkpoint of a rollback", () => {
  beforeEach(() => setup({}));

  test("survives every sweep until its rollback is confirmed, then expires with the policy", async () => {
    const box = await makeBox("alpha");
    const target = await take(box.boxId);
    const revision = host.specs.read(box.boxId)?.revision ?? 0;
    const rolled = await rollbackBox(host, box.boxId, { checkpoint: target.id, confirm: true, revision }, "owner");
    const safety = rolled.safety.id;
    const muchLater = Date.now() + 400 * DAY;

    expect(await applyRetention(host, muchLater)).toEqual([]);
    expect(host.checkpoints.read(safety)).not.toBeNull();

    await confirmRollback(host, box.boxId);
    expect(await applyRetention(host, muchLater)).toEqual([safety]);
    expect(host.checkpoints.read(safety)).toBeNull();
    expect(host.checkpoints.read(target.id)).not.toBeNull();
  });
});

describe("the capacity limit", () => {
  beforeEach(() => setup({ checkpointCapacityMb: 1 }));

  test("reports the size, the limit, the state and the policy the repository keeps", async () => {
    engine.reportedBytes = MB / 2;
    expect(await usageOf(host)).toEqual({
      bytes: MB / 2,
      limitBytes: MB,
      state: "ok",
      policy: { keepLast: 20, keepDays: 30 },
    });
  });

  test("a repository with no limit reports no limit", async () => {
    setup({ checkpointCapacityMb: 0 });
    engine.reportedBytes = 5 * MB;
    expect(await usageOf(host)).toMatchObject({ limitBytes: null, state: "unlimited" });
  });

  test("a rollback is refused while the repository is at its limit, and changes nothing", async () => {
    const box = await makeBox("alpha");
    const target = await take(box.boxId);
    const revision = host.specs.read(box.boxId)?.revision ?? 0;
    engine.reportedBytes = MB;
    const checkpoints = host.checkpoints.list().length;

    const error = await rejectionOf(
      rollbackBox(host, box.boxId, { checkpoint: target.id, confirm: true, revision }, "owner"),
    );

    expect(error).toMatchObject({ status: 409, key: "checkpoint_capacity_exceeded" });
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    expect(host.checkpoints.list()).toHaveLength(checkpoints);
    expect(host.specs.read(box.boxId)?.revision).toBe(revision);
  });

  test("a repository in the warning band still takes the safety checkpoint of a rollback", async () => {
    const box = await makeBox("alpha");
    const target = await take(box.boxId);
    const revision = host.specs.read(box.boxId)?.revision ?? 0;
    engine.reportedBytes = Math.floor(MB * 0.9);

    const rolled = await rollbackBox(host, box.boxId, { checkpoint: target.id, confirm: true, revision }, "owner");

    expect(host.checkpoints.read(rolled.safety.id)).toMatchObject({ auto: true });
  });

  test("a repository whose usage cannot be read does not refuse a rollback", async () => {
    const box = await makeBox("alpha");
    const target = await take(box.boxId);
    const revision = host.specs.read(box.boxId)?.revision ?? 0;
    engine.usageFails = true;

    await assertAutomaticAllowed(host);
    const rolled = await rollbackBox(host, box.boxId, { checkpoint: target.id, confirm: true, revision }, "owner");

    expect(host.checkpoints.read(rolled.safety.id)).not.toBeNull();
  });
});

/** A host with room for every request here, so the capacity check of a box create never decides the answer. */
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * 1024 * MB } } as unknown as HostMetrics;

describe("the usage route", () => {
  let harness: Harness;
  let restoreHttpLogs: () => void;

  beforeEach(() => {
    restoreHttpLogs = silenceLogs();
    harness = startHarness({ checkpointCapacityMb: 1 });
    harness.app.monitor.snapshot = async () => ROOMY_HOST;
  });

  afterEach(() => {
    harness.stop();
    restoreHttpLogs();
  });

  test("the owner reads the size, the limit, the state and the policy", async () => {
    const reply = await call(harness.base, "/api/checkpoints/usage");
    expect(reply.status).toBe(200);
    expect(reply.json as unknown).toEqual({
      bytes: 0,
      limitBytes: MB,
      state: "ok",
      policy: { keepLast: 20, keepDays: 30 },
    });
  });

  test("a token is refused with operation_forbidden, even one that holds every checkpoint scope", async () => {
    const admin = mint(harness.app, { name: "admin", preset: "admin" });
    const reply = await call(harness.base, "/api/checkpoints/usage", { token: admin.secret });
    expect(refused(reply)).toEqual({ status: 403, key: "operation_forbidden" });
  });

  test("a rollback over HTTP answers 409 before any task starts when the repository is full", async () => {
    const fake = harness.app.hosts.get().checkpointEngine as FakeCheckpointEngine;
    const made = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    expect(made.status).toBe(201);
    const box = made.json.box;
    if (!box) throw new Error("the box was not created");
    const taken = await call(harness.base, `/api/boxes/${box.boxId}/checkpoints`, { method: "POST", body: {} });
    expect(taken.status).toBe(202);
    const checkpoint = (await finishedTask(harness.base, taken.json.taskId ?? "")).result?.checkpoint;
    if (!checkpoint) throw new Error("the take returned no checkpoint");
    fake.reportedBytes = MB;

    const reply = await call(harness.base, `/api/boxes/${box.boxId}/rollback`, {
      method: "POST",
      body: { checkpoint: checkpoint.id, confirm: true },
      headers: { "if-match": String(box.revision) },
    });

    expect(refused(reply)).toEqual({ status: 409, key: "checkpoint_capacity_exceeded" });
  });
});
