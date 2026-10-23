import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Config } from "../src/config";
import type { AuditNote } from "../src/events/types";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { listTrash } from "../src/services/trash";
import { PRUNE_GRACE_MS, type PruneOptions, pruneVolumes } from "../src/services/volume-prune";
import { createVolume, deleteVolumes, planDeletes, previewDeleteVolumes } from "../src/services/volumes";
import type { TaskReader } from "../src/tasks/types";
import { createTestApp, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const DAY_MS = 24 * 60 * 60 * 1000;
const EVERYONE = async () => true;

let runtime: FakeRuntime;
let host: HostCtx;
let config: Config;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  runtime = created.runtime;
  config = created.app.cfg;
  host = created.app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true" });
});

const newBox = (name: string) => boxes.createBox(host, { name, cpus: 1, memoryMb: 256 });

/** A clock at which everything the test made is past the grace period. */
const pastGrace = () => Date.now() + 2 * PRUNE_GRACE_MS;

function pruning(overrides: Partial<PruneOptions> = {}): PruneOptions {
  const options = {
    dryRun: true,
    olderThanMs: null,
    principal: "owner",
    may: EVERYONE,
    now: pastGrace(),
    ...overrides,
  };
  return { ...options, ids: overrides.ids ?? null };
}

/** The ids a dry run lists, which a prune that removes volumes must name. */
async function listedIds(overrides: Partial<PruneOptions> = {}): Promise<string[]> {
  const preview = await pruneVolumes([host], pruning({ ...overrides, dryRun: true }));
  return preview.volumes.map((volume) => volume.id);
}

function recordOf(name: string) {
  const record = host.volumes.list().find((volume) => volume.name === name);
  if (!record) throw new Error(`no record for ${name}`);
  return record;
}

/** Moves a volume's creation and its last mount back in time, as a volume that has sat unused for a while looks. */
function backdate(name: string, { createdAt, lastMountAt }: { createdAt?: string; lastMountAt?: string }): void {
  const record = recordOf(name);
  host.volumes.write({
    ...record,
    createdAt: createdAt ?? record.createdAt,
    lastMount: record.lastMount && lastMountAt ? { ...record.lastMount, at: lastMountAt } : record.lastMount,
  });
}

const LONG_AGO = new Date(Date.now() - 30 * DAY_MS).toISOString();

/** A box deleted with its data kept: its volumes are orphans, and the box is their former box. */
async function deletedWithDataKept(name: string): Promise<boxes.Box> {
  const box = await newBox(name);
  await boxes.deleteBox(host, box.boxId, false);
  return box;
}

describe("finding orphaned volumes", () => {
  test("a volume its box still mounts is not an orphan", async () => {
    await newBox("alpha");
    const result = await pruneVolumes([host], pruning());
    expect(result.volumes).toEqual([]);
    expect(result.hosts.map((item) => item.status)).toEqual(["checked"]);
  });

  test("the volumes of a box deleted with its data kept are orphans, and the box is their former box", async () => {
    const alpha = await deletedWithDataKept("alpha");
    const mounted = alpha.mounts.filter((mount) => mount.role !== "tools").map((mount) => mount.volumeName ?? "");

    const result = await pruneVolumes([host], pruning());

    expect(result.volumes.map((volume) => volume.name).toSorted()).toEqual(mounted.toSorted());
    for (const volume of result.volumes) {
      expect(volume).toMatchObject({ status: "candidate", formerBox: "alpha", trash: null, error: null });
    }
  });

  test("the shared tools volume and a system volume are never orphans", async () => {
    await deletedWithDataKept("alpha");
    const tools = host.volumes.list().find((volume) => volume.role === "tools");
    if (!tools) throw new Error("the shared tools record is missing");
    runtime.volumes.set("mbtest-pool-nas", {
      name: "mbtest-pool-nas",
      labels: { [host.keys.volume]: "true", [host.keys.internal]: "true" },
    });

    const result = await pruneVolumes([host], pruning());

    const names = result.volumes.map((volume) => volume.name);
    expect(names).not.toContain(tools.name);
    expect(names).not.toContain("mbtest-pool-nas");
    expect(host.volumes.read(tools.id)).not.toBeNull();
  });

  test("a volume a container mounts is in use, even when no box spec names it", async () => {
    runtime.volumes.set("mbtest-ws-stray", { name: "mbtest-ws-stray", labels: {} });
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "stray",
      mounts: [{ source: "mbtest-ws-stray", target: "/workspace" }],
    });

    const result = await pruneVolumes([host], pruning());

    expect(result.volumes).toEqual([]);
    expect(runtime.volumes.has("mbtest-ws-stray")).toBe(true);
  });

  test("a legacy workspace volume with no labels is an orphan once nothing uses it", async () => {
    runtime.volumes.set("mbtest-ws-old", { name: "mbtest-ws-old", labels: {} });

    const result = await pruneVolumes([host], pruning());

    expect(result.volumes.map((volume) => volume.name)).toEqual(["mbtest-ws-old"]);
    expect(host.volumes.findByEngineName("mbtest-ws-old")).toMatchObject({
      role: "workspace",
      ownership: "independent",
    });
  });

  test("a volume MiniBox did not make is never listed", async () => {
    runtime.volumes.set("someone-elses", { name: "someone-elses", labels: {} });

    const result = await pruneVolumes([host], pruning());

    expect(result.volumes).toEqual([]);
    expect(host.volumes.findByEngineName("someone-elses")).toBeNull();
    expect(runtime.volumes.has("someone-elses")).toBe(true);
  });

  test("a volume created within the grace period is left alone", async () => {
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });

    expect((await pruneVolumes([host], pruning({ now: Date.now() }))).volumes).toEqual([]);
    expect((await pruneVolumes([host], pruning())).volumes.map((volume) => volume.name)).toEqual(["notes"]);
  });

  test("the grace period counts from the last mount, so a volume a box left a moment ago waits even if created long ago", async () => {
    const alpha = await deletedWithDataKept("alpha");
    const workspace = alpha.mounts.find((mount) => mount.role === "workspace")?.volumeName ?? "";
    backdate(workspace, { createdAt: LONG_AGO });

    const soon = await pruneVolumes([host], pruning({ now: Date.now() + 60_000 }));
    expect(soon.volumes.map((volume) => volume.name)).not.toContain(workspace);

    const later = await pruneVolumes([host], pruning());
    expect(later.volumes.map((volume) => volume.name)).toContain(workspace);
  });

  test("olderThan keeps the volumes used more recently than its age", async () => {
    await deletedWithDataKept("alpha");
    const week = 7 * DAY_MS;

    expect((await pruneVolumes([host], pruning({ olderThanMs: week }))).volumes).toEqual([]);
    const eightDays = await pruneVolumes([host], pruning({ olderThanMs: week, now: Date.now() + 8 * DAY_MS }));
    expect(eightDays.volumes.length).toBeGreaterThan(0);
  });
});

describe("dry run and removal", () => {
  test("a dry run lists each orphan with its last use and former box, and removes nothing", async () => {
    await deletedWithDataKept("alpha");
    const before = host.volumes.list().length;

    const result = await pruneVolumes([host], pruning());

    expect(result.volumes.length).toBeGreaterThan(0);
    for (const volume of result.volumes) {
      const record = recordOf(volume.name);
      expect(volume.lastUsedAt).toBe(record.lastMount?.at ?? record.createdAt);
      expect(volume.status).toBe("candidate");
    }
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
    expect(host.volumes.list()).toHaveLength(before);
    expect(await listTrash(host)).toEqual([]);
  });

  test("applying removes each orphan, keeps a recycle bin copy of the data where a delete keeps one, and records each removal", async () => {
    await deletedWithDataKept("alpha");
    const engines = new Map(host.volumes.list().map((volume) => [volume.name, volume.engineName]));
    const notes: AuditNote[] = [];
    const seen: string[] = [];
    const ids = await listedIds();

    const result = await pruneVolumes(
      [host],
      pruning({ dryRun: false, ids, record: (note) => notes.push(note), onRemoval: (row) => seen.push(row.name) }),
    );

    expect(result.volumes.length).toBeGreaterThan(0);
    expect(result.volumes.every((volume) => volume.status === "removed")).toBe(true);
    expect(seen.toSorted()).toEqual(result.volumes.map((volume) => volume.name).toSorted());
    for (const volume of result.volumes) {
      expect(runtime.volumes.has(engines.get(volume.name) ?? "")).toBe(false);
      expect(host.volumes.findByEngineName(engines.get(volume.name) ?? "")).toBeNull();
    }

    const kept = result.volumes.filter((volume) => volume.trash !== null).map((volume) => volume.name);
    const cache = result.volumes.filter((volume) => volume.trash === null).map((volume) => volume.name);
    expect(kept.length).toBeGreaterThan(0);
    expect(cache.length).toBeGreaterThan(0);
    expect((await listTrash(host)).map((entry) => entry.sourceName).toSorted()).toEqual(kept.toSorted());

    expect(notes.filter((note) => note.op === "volume.delete")).toEqual(
      result.volumes.map((volume) =>
        expect.objectContaining({
          op: "volume.delete",
          status: "ok",
          summary: `Orphaned volume removed: ${volume.name}`,
          target: expect.objectContaining({ kind: "volume", name: volume.name }),
        }),
      ),
    );
  });

  test("a volume a container starts using before its removal is refused, and the copy kept for it is discarded", async () => {
    await deletedWithDataKept("alpha");
    const engines = host.volumes
      .list()
      .filter((volume) => volume.name.startsWith("alpha-"))
      .map((volume) => volume.engineName);
    const ids = await listedIds();
    const listed = runtime.listContainers.bind(runtime);
    let listings = 0;
    const late = spyOn(runtime, "listContainers").mockImplementation(async (filter, options) => {
      listings += 1;
      if (listings === 2) {
        runtime.seedContainer({
          image: host.baseTemplateTag,
          name: "late",
          mounts: engines.map((source) => ({ source, target: `/mnt/${source}` })),
        });
      }
      return listed(filter, options);
    });

    let result: Awaited<ReturnType<typeof pruneVolumes>>;
    try {
      result = await pruneVolumes([host], pruning({ dryRun: false, ids }));
    } finally {
      late.mockRestore();
    }

    expect(result.volumes.length).toBeGreaterThan(0);
    for (const volume of result.volumes) {
      expect(volume).toMatchObject({ status: "refused", trash: null, error: { key: "volume_in_use_by_box" } });
    }
    expect(await listTrash(host)).toEqual([]);
    for (const engine of engines) expect(runtime.volumes.has(engine)).toBe(true);
  });

  test("a volume the engine fails to remove is reported failed with its copy purged, and the other orphans are removed", async () => {
    await deletedWithDataKept("alpha");
    const workspace = recordOf("alpha-workspace").engineName;
    const ids = await listedIds();
    const removed = runtime.removeVolume.bind(runtime);
    const broken = spyOn(runtime, "removeVolume").mockImplementation(async (name) => {
      if (name === workspace) throw new RuntimeError("engine", "device busy", "device busy");
      return removed(name);
    });

    let result: Awaited<ReturnType<typeof pruneVolumes>>;
    try {
      result = await pruneVolumes([host], pruning({ dryRun: false, ids }));
    } finally {
      broken.mockRestore();
    }

    const failed = result.volumes.filter((volume) => volume.status === "failed");
    expect(failed.map((volume) => [volume.name, volume.error?.key])).toEqual([
      ["alpha-workspace", "volume_delete_failed"],
    ]);
    expect(result.volumes.filter((volume) => volume.status === "removed")).toHaveLength(result.volumes.length - 1);
    expect((await listTrash(host)).map((entry) => entry.sourceName)).not.toContain("alpha-workspace");
    expect(runtime.volumes.has(workspace)).toBe(true);
  });

  test("a host that is offline is reported and skipped, and the other hosts are still pruned", async () => {
    await deletedWithDataKept("alpha");
    const offline: HostCtx = {
      ...host,
      host: { ...host.host, id: "nas-1", name: "NAS", transport: "ssh", status: "offline" },
    };

    const result = await pruneVolumes([offline, host], pruning());

    expect(result.hosts).toContainEqual(
      expect.objectContaining({
        hostId: "nas-1",
        status: "offline",
        error: expect.objectContaining({ key: "volume_host_offline" }),
      }),
    );
    expect(result.volumes.length).toBeGreaterThan(0);
    expect(result.volumes.every((volume) => volume.hostId === host.host.id)).toBe(true);
  });

  test("a host that cannot list its containers is reported failed, and the next host is still pruned", async () => {
    const lab = createLocalHost(config, runtime, host.specs, host.volumes, undefined, host.pulse, {
      id: "lab",
      name: "Lab",
    });
    await createVolume(lab, { name: "lab-data", role: null, createdBy: null });
    runtime.fail("listContainers", new RuntimeError("engine", "boom", "boom"));

    const result = await pruneVolumes([host, lab], pruning());

    expect(result.hosts).toEqual([
      expect.objectContaining({
        hostId: host.host.id,
        status: "failed",
        error: expect.objectContaining({ key: "volume_host_failed" }),
      }),
      expect.objectContaining({ hostId: "lab", status: "checked" }),
    ]);
    expect(result.volumes.map((volume) => [volume.hostId, volume.name])).toEqual([["lab", "lab-data"]]);
  });

  test("a host running a move or a rollback is busy, and its orphans wait for it", async () => {
    await deletedWithDataKept("alpha");
    const busy = { list: () => [{ hostId: host.host.id, op: "box.move" }] } as unknown as TaskReader;

    const result = await pruneVolumes([host], pruning({ tasks: busy }));

    expect(result.volumes).toEqual([]);
    expect(result.hosts).toEqual([
      expect.objectContaining({ status: "failed", error: expect.objectContaining({ key: "volume_prune_busy" }) }),
    ]);
  });

  test("a task that does not fill volumes does not hold the prune back", async () => {
    await deletedWithDataKept("alpha");
    const starting = { list: () => [{ hostId: host.host.id, op: "box.start" }] } as unknown as TaskReader;

    const result = await pruneVolumes([host], pruning({ tasks: starting }));

    expect(result.volumes.length).toBeGreaterThan(0);
  });
});

describe("a prune names what it removes", () => {
  test("applying without the ids a dry run listed is refused, and nothing is removed", async () => {
    await deletedWithDataKept("alpha");
    const before = host.volumes.list().length;
    await expect(pruneVolumes([host], pruning({ dryRun: false }))).rejects.toMatchObject({
      key: "volume_prune_ids_required",
    });
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
    expect(host.volumes.list()).toHaveLength(before);
  });

  test("only the named orphans are removed, though more orphans appeared after the dry run", async () => {
    await deletedWithDataKept("alpha");
    const ids = await listedIds();
    await deletedWithDataKept("beta");
    const betas = host.volumes.list().filter((volume) => volume.name.startsWith("beta-"));
    expect(betas.length).toBeGreaterThan(0);

    const result = await pruneVolumes([host], pruning({ dryRun: false, ids }));

    expect(result.volumes.map((volume) => volume.id)).toEqual(ids);
    expect(result.volumes.every((volume) => volume.status === "removed")).toBe(true);
    for (const beta of betas) expect(host.volumes.read(beta.id)).not.toBeNull();
  });

  test("a named volume a box mounts, a box owns again, or the tools volume is refused with its reason and kept", async () => {
    await deletedWithDataKept("alpha");
    await newBox("live");
    const tools = host.volumes.list().find((volume) => volume.role === "tools");
    if (!tools) throw new Error("the shared tools record is missing");
    const ids = await listedIds();
    const home = recordOf("alpha-home");
    host.volumes.write({ ...home, ownership: "owned", ownerBoxId: recordOf("live-workspace").ownerBoxId });
    const engines = host.volumes.list().map((volume) => volume.engineName);

    const result = await pruneVolumes(
      [host],
      pruning({ dryRun: false, ids: [home.id, recordOf("live-workspace").id, tools.id, "vol_missing"] }),
    );

    expect(result.volumes.map((volume) => [volume.name, volume.status, volume.error?.key ?? null])).toEqual([
      ["alpha-home", "refused", "volume_not_orphan"],
      ["live-workspace", "refused", "volume_in_use_by_box"],
      [tools.name, "refused", "volume_shared_tools"],
      ["vol_missing", "refused", "volume_not_found"],
    ]);
    expect(ids).toContain(home.id);
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
    for (const engine of engines) expect(runtime.volumes.has(engine)).toBe(true);
  });

  test("a volume named like the shared tools volume is protected even if its record lost the role", async () => {
    const odd = await createVolume(host, { name: "odd", role: null, createdBy: "owner" });
    const engineName = `${host.prefix}-tools-elsewhere`;
    runtime.volumes.set(engineName, { name: engineName, labels: { [host.keys.volume]: "true" } });
    host.volumes.write({ ...recordOf("odd"), engineName });
    const ids = [odd.id];

    const result = await pruneVolumes([host], pruning({ dryRun: false, ids }));

    expect(result.volumes.map((volume) => [volume.status, volume.error?.key])).toEqual([
      ["refused", "volume_shared_tools"],
    ]);
    expect(runtime.volumes.has(engineName)).toBe(true);
  });
});

describe("batch delete", () => {
  test("each name is judged once: a mounted volume and the shared tools volume are refused, and the rest are removed in the order named", async () => {
    await newBox("alpha");
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    await createVolume(host, { name: "scratch", role: null, createdBy: "owner" });
    const tools = host.volumes.list().find((volume) => volume.role === "tools");
    if (!tools) throw new Error("the shared tools record is missing");

    const plans = await planDeletes(
      host,
      [host],
      ["scratch", "alpha-workspace", "notes", "scratch", "missing", tools.name],
      EVERYONE,
    );
    expect(plans.map((plan) => [plan.ref, plan.blocked])).toEqual([
      ["scratch", null],
      ["alpha-workspace", "in_use"],
      ["notes", null],
      ["missing", "not_found"],
      [tools.name, "tools"],
    ]);

    const deleted = await deleteVolumes(plans, { skipTrash: false, createdBy: "owner" });
    expect(deleted.map((row) => [row.name, row.status, row.error?.key ?? null])).toEqual([
      ["scratch", "removed", null],
      ["alpha-workspace", "refused", "volume_in_use_by_box"],
      ["notes", "removed", null],
      ["missing", "failed", "volume_not_found"],
      [tools.name, "refused", "volume_shared_tools"],
    ]);
    expect(host.volumes.list().map((volume) => volume.name)).toEqual(
      expect.arrayContaining(["alpha-workspace", tools.name]),
    );
  });

  test("a volume the caller may not delete is refused as forbidden, and an offline host fails only its own volumes", async () => {
    const nas: HostCtx = { ...host, host: { ...host.host, id: "nas-1", name: "NAS" } };
    await createVolume(nas, { name: "nas-data", role: null, createdBy: null });
    const offline: HostCtx = { ...nas, host: { ...nas.host, transport: "ssh", status: "offline" } };
    await createVolume(host, { name: "mine", role: null, createdBy: "owner" });
    await createVolume(host, { name: "theirs", role: null, createdBy: "owner" });

    const plans = await planDeletes(
      host,
      [host, offline],
      ["mine", "theirs", "nas-data"],
      async (volume) => volume.name !== "theirs",
    );
    const deleted = await deleteVolumes(plans, { skipTrash: false, createdBy: "owner" });

    expect(deleted.map((row) => [row.name, row.status, row.error?.key ?? null])).toEqual([
      ["mine", "removed", null],
      ["theirs", "refused", "volume_delete_forbidden"],
      ["nas-data", "failed", "volume_host_offline"],
    ]);
  });

  test("a delete the engine fails is reported failed with its copy purged, and the rest of the batch still deletes", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    await createVolume(host, { name: "scratch", role: null, createdBy: "owner" });
    const removed = runtime.removeVolume.bind(runtime);
    const broken = spyOn(runtime, "removeVolume").mockImplementation(async (name) => {
      if (name === notes.engineName) throw new RuntimeError("engine", "device busy", "device busy");
      return removed(name);
    });

    try {
      const plans = await planDeletes(host, [host], ["notes", "scratch"], EVERYONE);
      const deleted = await deleteVolumes(plans, { skipTrash: false, createdBy: "owner" });

      expect(deleted.map((row) => [row.name, row.status, row.error?.key ?? null])).toEqual([
        ["notes", "failed", "volume_delete_failed"],
        ["scratch", "removed", null],
      ]);
      expect((await listTrash(host)).map((entry) => entry.sourceName)).toEqual(["scratch"]);
    } finally {
      broken.mockRestore();
    }
  });

  test("a volume a container starts using between the plan and the delete is refused, and its copy discarded", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const plans = await planDeletes(host, [host], ["notes"], EVERYONE);
    expect(plans.map((plan) => plan.blocked)).toEqual([null]);
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "late",
      mounts: [{ source: notes.engineName, target: "/data" }],
    });

    const deleted = await deleteVolumes(plans, { skipTrash: false, createdBy: "owner" });

    expect(deleted.map((row) => [row.status, row.error?.key])).toEqual([["refused", "volume_in_use_by_box"]]);
    expect(runtime.volumes.has(notes.engineName)).toBe(true);
    expect(host.volumes.read(notes.id)).not.toBeNull();
    expect(await listTrash(host)).toEqual([]);
  });

  test("a system volume, by its engine label, and a volume named like the tools volume are never deleted", async () => {
    const system = await createVolume(host, { name: "system", role: null, createdBy: "owner" });
    const info = runtime.volumes.get(system.engineName);
    if (!info) throw new Error("no engine volume");
    runtime.volumes.set(system.engineName, { ...info, labels: { ...info.labels, [host.keys.internal]: "true" } });
    await createVolume(host, { name: "odd", role: null, createdBy: "owner" });
    const engineName = `${host.prefix}-tools-elsewhere`;
    runtime.volumes.set(engineName, { name: engineName, labels: { [host.keys.volume]: "true" } });
    host.volumes.write({ ...recordOf("odd"), engineName });

    const plans = await planDeletes(host, [host], ["system", "odd"], EVERYONE);
    expect(plans.map((plan) => plan.blocked)).toEqual([null, "tools"]);
    const deleted = await deleteVolumes(plans, { skipTrash: true, createdBy: "owner" });

    expect(deleted.map((row) => [row.name, row.status, row.error?.key])).toEqual([
      ["system", "refused", "volume_system"],
      ["odd", "refused", "volume_shared_tools"],
    ]);
    expect(runtime.volumes.has(system.engineName)).toBe(true);
    expect(runtime.volumes.has(engineName)).toBe(true);
  });

  test("skipTrash deletes without keeping a copy", async () => {
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const plans = await planDeletes(host, [host], ["notes"], EVERYONE);

    const deleted = await deleteVolumes(plans, { skipTrash: true, createdBy: "owner" });

    expect(deleted).toEqual([expect.objectContaining({ name: "notes", status: "removed", trash: null })]);
    expect(await listTrash(host)).toEqual([]);
  });

  test("the preview says what each name would do, and changes nothing", async () => {
    await newBox("alpha");
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const plans = await planDeletes(host, [host], ["notes", "alpha-workspace"], EVERYONE);

    expect(previewDeleteVolumes(plans, false)).toEqual({
      action: "delete_volumes",
      volumes: [
        expect.objectContaining({ name: "notes", role: null, blocked: null, trash: true }),
        expect.objectContaining({ name: "alpha-workspace", role: "workspace", blocked: "in_use", trash: true }),
      ],
    });
    expect(host.volumes.list().map((volume) => volume.name)).toContain("notes");
  });
});
