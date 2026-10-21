import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { legacyCheckpointId } from "../src/checkpoints/id";
import type { HostCtx } from "../src/host/registry";
import { labelChange } from "../src/labels";
import { type CommitSpec, RuntimeError } from "../src/runtime";
import type { Box } from "../src/services/boxes";
import * as boxes from "../src/services/boxes";
import {
  type CheckpointView,
  deleteCheckpoint,
  forkCheckpoint,
  getCheckpoint,
  listCheckpoints,
  type RollbackResult,
  rollbackBox,
  takeCheckpoint,
  type TakeCheckpointInput,
  updateCheckpoint,
} from "../src/services/checkpoints";
import { newBoxId } from "../src/specs/revision";
import type { BoxMount } from "../src/specs/types";
import { createIndependentVolume, provisionDefaultMounts } from "../src/volumes/provision";
import type { VolumeRecord } from "../src/volumes/types";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";

let runtime: FakeRuntime;
let engine: FakeCheckpointEngine;
let host: HostCtx;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  runtime = created.runtime;
  engine = created.checkpoints;
  host = created.app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true" });
});

const NOTHING: TakeCheckpointInput = {
  pinned: false,
  include: { system: false, volumes: [] },
  consistency: "live",
};

function take(ref: string, overrides: Partial<TakeCheckpointInput> = {}): Promise<CheckpointView> {
  return takeCheckpoint(host, ref, { ...NOTHING, ...overrides }, "owner");
}

function rollback(boxId: string, checkpoint: string, confirm: boolean): Promise<RollbackResult> {
  const revision = host.specs.read(boxId)?.revision ?? 0;
  return rollbackBox(host, boxId, { checkpoint, confirm, revision }, "owner");
}

function makeBox(name: string): Promise<Box> {
  return boxes.createBox(host, { name, cpus: 1, memoryMb: 512, createdBy: "owner" });
}

/** A box with the default volumes, plus `extra` mounts. With `defaults` false, the box mounts only `extra`. */
async function boxWith(name: string, extra: BoxMount[], defaults = true): Promise<Box> {
  const id = newBoxId();
  const roles = defaults ? await provisionDefaultMounts(host, { id, name, createdBy: "owner" }, new Set()) : [];
  return boxes.createBox(host, { id, name, cpus: 1, memoryMb: 512, createdBy: "owner", mounts: [...roles, ...extra] });
}

async function sharedVolume(name: string): Promise<VolumeRecord> {
  return createIndependentVolume(host, { name, role: null, createdBy: "owner" }, new Set());
}

function engineAt(boxId: string, path: string): string {
  const mount = host.specs.read(boxId)?.mounts.find((item) => item.path === path);
  if (!mount) throw new Error(`no mount at ${path}`);
  return mount.volume;
}

function filesOf(volume: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of runtime.filesOf(volume)) {
    if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
  }
  return out;
}

function seed(volume: string, path: string, text: string): void {
  runtime.seedVolumeFile(volume, path, { type: "file", content: Buffer.from(text), mode: 0o644, uid: 1000, gid: 1000 });
}

const commitsOf = (): CommitSpec[] => runtime.callsTo("commitContainer").map((call) => call.args[1] as CommitSpec);

const opsOf = (names: string[], since = 0): string[] =>
  runtime.calls
    .slice(since)
    .map((call) => call.op)
    .filter((op) => names.includes(op));

const tagged = (tag: string): boolean => [...runtime.images.values()].some((image) => image.tags.includes(tag));

describe("taking a checkpoint", () => {
  test("by default the owned workspace and home are taken, and cache and tools are not", async () => {
    const box = await makeBox("alpha");
    seed(engineAt(box.boxId, "/workspace"), "src/app.ts", "console.log(1)");
    seed(engineAt(box.boxId, "/home/dev"), ".bashrc", "alias ll=ls");

    const view = await take(box.boxId);

    expect(view.data.map((layer) => layer.path)).toEqual(["/workspace", "/home/dev"]);
    expect(view.data.every((layer) => layer.ownership === "owned")).toBe(true);
    expect(view.system).toBeNull();
    expect(view.spec).toMatchObject({ cpus: 1, memoryBytes: 512 * 1024 * 1024, profile: box.profile });
    expect(runtime.callsTo("commitContainer")).toHaveLength(0);
    expect(host.checkpoints.read(view.id)).toMatchObject({ id: view.id, boxId: box.boxId, pinned: false, auto: false });
  });

  test("each layer records the root owner of its volume and the snapshot the engine returned", async () => {
    const box = await makeBox("alpha");
    const workspace = engineAt(box.boxId, "/workspace");
    runtime.seedVolumeOwner(workspace, { uid: 1234, gid: 1234 });

    const view = await take(box.boxId);

    const layer = view.data.find((item) => item.path === "/workspace");
    expect(layer?.owner).toEqual({ uid: 1234, gid: 1234 });
    expect(engine.snapshots.get(layer?.snapshotId ?? "")?.tags).toEqual(
      expect.arrayContaining([`checkpoint:${view.id}`, `box:${box.boxId}`]),
    );
  });

  test("a shared volume the box mounts is taken only when it is named", async () => {
    const shared = await sharedVolume("shared-data");
    const box = await boxWith("alpha", [{ volume: shared.engineName, path: "/data", mode: "ro" }]);

    const withoutNaming = await take(box.boxId);
    const named = await take(box.boxId, { include: { system: false, volumes: [shared.id] } });

    expect(withoutNaming.data.map((layer) => layer.path)).toEqual(["/workspace", "/home/dev"]);
    expect(named.data.map((layer) => layer.path)).toEqual(["/workspace", "/home/dev", "/data"]);
    expect(named.data.at(-1)).toMatchObject({ mode: "ro", ownership: "independent", volumeId: shared.id });
  });

  test("a volume the box does not mount is refused, with nothing taken", async () => {
    const box = await makeBox("alpha");
    const unmounted = await sharedVolume("not-mounted");

    const error = await rejectionOf(take(box.boxId, { include: { system: false, volumes: [unmounted.id] } }));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_volume_not_mounted" });
    expect(engine.snapshots.size).toBe(0);
    expect(host.checkpoints.list()).toEqual([]);
  });

  test("cache and tools volumes are refused when they are named", async () => {
    const box = await makeBox("alpha");
    const cache = host.volumes.findByEngine(host.host.id, engineAt(box.boxId, "/home/dev/.cache"));
    const tools = host.volumes.findByEngine(host.host.id, engineAt(box.boxId, "/opt/minibox/tools"));

    for (const volume of [cache, tools]) {
      const error = await rejectionOf(take(box.boxId, { include: { system: false, volumes: [volume?.id ?? ""] } }));
      expect(error).toMatchObject({ status: 400, key: "checkpoint_volume_excluded" });
    }
  });

  test("the system layer is committed paused, labelled with the checkpoint, and recorded by image id", async () => {
    const box = await makeBox("alpha");

    const view = await take(box.boxId, { include: { system: true, volumes: [] } });

    expect(commitsOf()).toEqual([
      expect.objectContaining({
        repo: "mbtest-checkpoint",
        tag: view.id,
        pause: true,
        changes: expect.arrayContaining([labelChange(host.keys.checkpoint, view.id)]),
      }),
    ]);
    const image = await runtime.inspectImage(`mbtest-checkpoint:${view.id}`);
    expect(view.system).toEqual({ image: `mbtest-checkpoint:${view.id}`, imageId: image.id });
  });

  test("pause freezes a running box around the backups and unpauses it after", async () => {
    const box = await makeBox("alpha");
    const since = runtime.calls.length;

    await take(box.boxId, { consistency: "pause" });

    expect(opsOf(["pauseContainer", "volumeRootOwner", "unpauseContainer"], since)).toEqual([
      "pauseContainer",
      "volumeRootOwner",
      "volumeRootOwner",
      "unpauseContainer",
    ]);
    expect(runtime.containers.get(box.id)?.paused).toBe(false);
  });

  test("stop stops a running box for the backups, starts it again, and leaves its desired state running", async () => {
    const box = await makeBox("alpha");
    const since = runtime.calls.length;

    await take(box.boxId, { consistency: "stop" });

    expect(opsOf(["stopContainer", "volumeRootOwner", "startContainer"], since)).toEqual([
      "stopContainer",
      "volumeRootOwner",
      "volumeRootOwner",
      "startContainer",
    ]);
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.lifecycle.desired).toBe("running");
  });

  test("live leaves a running box running and unpaused", async () => {
    const box = await makeBox("alpha");
    const since = runtime.calls.length;

    await take(box.boxId, { consistency: "live" });

    expect(opsOf(["pauseContainer", "unpauseContainer", "stopContainer"], since)).toEqual([]);
    expect(runtime.containers.get(box.id)?.running).toBe(true);
  });

  test("a backup that fails takes back what was already taken, and resumes the box", async () => {
    const box = await makeBox("alpha");
    engine.failBackupOf.add(engineAt(box.boxId, "/home/dev"));

    const error = await rejectionOf(take(box.boxId, { consistency: "pause", include: { system: true, volumes: [] } }));

    expect(error).toBeInstanceOf(RuntimeError);
    expect(engine.snapshots.size).toBe(0);
    expect(host.checkpoints.list()).toEqual([]);
    const images = [...runtime.images.values()].filter((image) =>
      image.tags.some((tag) => tag.startsWith("mbtest-checkpoint:")),
    );
    expect(images).toEqual([]);
    expect(runtime.containers.get(box.id)?.paused).toBe(false);
  });
});

describe("forking a checkpoint", () => {
  test("the fork restores the workspace into its own volume, identical to the checkpoint, and the source is untouched", async () => {
    const source = await makeBox("alpha");
    const workspace = engineAt(source.boxId, "/workspace");
    seed(workspace, "src/app.ts", "console.log(1)");
    seed(workspace, "README.md", "hello");
    const view = await take(source.boxId);
    seed(workspace, "after.txt", "written after the checkpoint");

    const forked = await forkCheckpoint(
      host,
      view.id,
      {
        name: "alpha-fork",
        cpus: 1,
        memoryMb: 512,
        copyHome: false,
      },
      "owner",
    );

    const forkWorkspace = engineAt(forked.boxId, "/workspace");
    expect(forkWorkspace).not.toBe(workspace);
    expect(filesOf(forkWorkspace)).toEqual({ "src/app.ts": "console.log(1)", "README.md": "hello" });
    expect(filesOf(workspace)).toMatchObject({ "after.txt": "written after the checkpoint" });
    expect(host.volumes.findByEngine(host.host.id, forkWorkspace)).toMatchObject({
      ownership: "owned",
      ownerBoxId: forked.boxId,
      role: "workspace",
    });
    expect(forked.name).toBe("alpha-fork");
  });

  test("the restored root keeps the owner the checkpoint recorded", async () => {
    const source = await makeBox("alpha");
    runtime.seedVolumeOwner(engineAt(source.boxId, "/workspace"), { uid: 1234, gid: 1234 });
    const view = await take(source.boxId);

    const forked = await forkCheckpoint(
      host,
      view.id,
      { name: "owned", cpus: 1, memoryMb: 512, copyHome: false },
      "owner",
    );

    expect(runtime.volumeOwners.get(engineAt(forked.boxId, "/workspace"))).toEqual({ uid: 1234, gid: 1234 });
  });

  test("home starts empty unless copyHome asks for its content", async () => {
    const source = await makeBox("alpha");
    seed(engineAt(source.boxId, "/home/dev"), ".bashrc", "alias ll=ls");
    const view = await take(source.boxId);

    const fresh = await forkCheckpoint(
      host,
      view.id,
      { name: "fresh", cpus: 1, memoryMb: 512, copyHome: false },
      "owner",
    );
    const copied = await forkCheckpoint(
      host,
      view.id,
      { name: "copied", cpus: 1, memoryMb: 512, copyHome: true },
      "owner",
    );

    expect(filesOf(engineAt(fresh.boxId, "/home/dev"))).toEqual({});
    expect(filesOf(engineAt(copied.boxId, "/home/dev"))).toEqual({ ".bashrc": "alias ll=ls" });
  });

  test("a shared layer is copied into a new independent volume at the same path and mode", async () => {
    const shared = await sharedVolume("shared-data");
    seed(shared.engineName, "dataset.csv", "a,b");
    const source = await boxWith("alpha", [{ volume: shared.engineName, path: "/data", mode: "ro" }]);
    const view = await take(source.boxId, { include: { system: false, volumes: [shared.id] } });

    const forked = await forkCheckpoint(
      host,
      view.id,
      { name: "copy", cpus: 1, memoryMb: 512, copyHome: false },
      "owner",
    );

    const copy = forked.mounts.find((mount) => mount.path === "/data");
    expect(copy).toMatchObject({ mode: "ro" });
    expect(copy?.volume).not.toBe(shared.engineName);
    expect(host.volumes.findByEngine(host.host.id, copy?.volume ?? "")).toMatchObject({ ownership: "independent" });
    expect(filesOf(copy?.volume ?? "")).toEqual({ "dataset.csv": "a,b" });
  });

  test("a copy that would sit on a default path is refused", async () => {
    const shared = await sharedVolume("shadow");
    const box = await boxWith("gamma", [{ volume: shared.engineName, path: "/home/dev", mode: "rw" }], false);
    const view = await take(box.boxId, { include: { system: false, volumes: [shared.id] } });

    const error = await rejectionOf(
      forkCheckpoint(host, view.id, { name: "clash", cpus: 1, memoryMb: 512, copyHome: false }, "owner"),
    );

    expect(error).toMatchObject({ status: 409, key: "checkpoint_path_taken" });
    expect(host.specs.list().map((spec) => spec.name)).toEqual(["gamma"]);
  });

  test("the fork starts from the committed image when the checkpoint has a system layer", async () => {
    const source = await makeBox("alpha");
    const view = await take(source.boxId, { include: { system: true, volumes: [] } });

    const forked = await forkCheckpoint(
      host,
      view.id,
      { name: "from-image", cpus: 1, memoryMb: 512, copyHome: false },
      "owner",
    );

    expect(runtime.callsTo("createContainer").at(-1)?.args[0]).toMatchObject({ image: `mbtest-checkpoint:${view.id}` });
    expect(forked.template).toBe(source.template);
  });

  test("a fork that fails removes the volumes it restored", async () => {
    const source = await makeBox("alpha");
    seed(engineAt(source.boxId, "/workspace"), "a.txt", "a");
    const view = await take(source.boxId);
    const before = new Set(runtime.volumes.keys());
    runtime.fail("createContainer", new RuntimeError("engine", "container refused"));

    await expect(
      forkCheckpoint(host, view.id, { name: "doomed", cpus: 1, memoryMb: 512, copyHome: false }, "owner"),
    ).rejects.toThrow("container refused");

    expect(new Set(runtime.volumes.keys())).toEqual(before);
    expect(host.specs.list().map((spec) => spec.name)).toEqual(["alpha"]);
  });
});

describe("rolling a box back", () => {
  test("without confirm, nothing changes and the 409 carries the preview", async () => {
    const box = await makeBox("alpha");
    const view = await take(box.boxId);
    const before = host.specs.read(box.boxId);
    seed(engineAt(box.boxId, "/workspace"), "later.txt", "later");

    const error = await rejectionOf(rollback(box.boxId, view.id, false));

    expect(error).toMatchObject({ status: 409, code: "confirmation_required" });
    const preview = (error as { details?: { preview?: { restores: unknown[]; revision: unknown } } }).details?.preview;
    expect(preview?.restores).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/workspace", role: "workspace" })]),
    );
    expect(preview?.revision).toEqual({ current: before?.revision, next: (before?.revision ?? 0) + 1 });
    expect(host.specs.read(box.boxId)?.mounts).toEqual(before?.mounts);
  });

  test("with confirm, the box is rebuilt onto restored volumes and the replaced volume is kept", async () => {
    const box = await makeBox("alpha");
    const workspace = engineAt(box.boxId, "/workspace");
    seed(workspace, "kept.txt", "from the checkpoint");
    const view = await take(box.boxId);
    seed(workspace, "later.txt", "written after the checkpoint");
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    const result = await rollback(box.boxId, view.id, true);

    const restored = engineAt(box.boxId, "/workspace");
    expect(restored).not.toBe(workspace);
    expect(filesOf(restored)).toEqual({ "kept.txt": "from the checkpoint" });
    expect(filesOf(workspace)).toMatchObject({ "later.txt": "written after the checkpoint" });
    expect(runtime.volumes.has(workspace)).toBe(true);
    expect(result.replaced).toEqual(expect.arrayContaining([expect.objectContaining({ name: "alpha-workspace" })]));
    expect(host.specs.read(box.boxId)?.revision).toBe(revision + 1);
    expect(host.volumes.findByEngine(host.host.id, restored)).toMatchObject({
      ownerBoxId: box.boxId,
      ownership: "owned",
    });
  });

  test("the restored workspace root gets the owner the checkpoint recorded", async () => {
    const box = await makeBox("alpha");
    runtime.seedVolumeOwner(engineAt(box.boxId, "/workspace"), { uid: 1234, gid: 1234 });
    const view = await take(box.boxId);

    await rollback(box.boxId, view.id, true);

    expect(runtime.volumeOwners.get(engineAt(box.boxId, "/workspace"))).toEqual({ uid: 1234, gid: 1234 });
  });

  test("a checkpoint of another box is refused", async () => {
    const alpha = await makeBox("alpha");
    const beta = await makeBox("beta");
    const view = await take(alpha.boxId);

    const error = await rejectionOf(rollback(beta.boxId, view.id, true));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_other_box" });
  });

  test("a checkpoint with no owned volume has nothing to roll back", async () => {
    const shared = await sharedVolume("only-shared");
    const box = await boxWith("alpha", [{ volume: shared.engineName, path: "/data", mode: "rw" }], false);
    const view = await take(box.boxId, { include: { system: false, volumes: [shared.id] } });

    const error = await rejectionOf(rollback(box.boxId, view.id, true));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_no_data" });
  });
});

describe("listing, reading, changing and deleting", () => {
  test("pinning and relabelling persist, and a pinned checkpoint cannot be deleted until it is unpinned", async () => {
    const box = await makeBox("alpha");
    const view = await take(box.boxId);

    const updated = await updateCheckpoint(host, view.id, { pinned: true, label: "before refactor" });
    expect(updated).toMatchObject({ pinned: true, label: "before refactor" });
    expect(await getCheckpoint(host, view.id)).toMatchObject({ pinned: true, label: "before refactor" });

    const refused = await rejectionOf(deleteCheckpoint(host, view.id));
    expect(refused).toMatchObject({ status: 409, key: "checkpoint_pinned" });
    expect(host.checkpoints.read(view.id)).not.toBeNull();

    await updateCheckpoint(host, view.id, { pinned: false });
    await deleteCheckpoint(host, view.id);
    expect(host.checkpoints.read(view.id)).toBeNull();
    expect(engine.snapshots.size).toBe(0);
  });

  test("delete removes the snapshots and the system image of the checkpoint", async () => {
    const box = await makeBox("alpha");
    const view = await take(box.boxId, { include: { system: true, volumes: [] } });
    const systemImage = view.system?.imageId ?? "";
    expect(engine.snapshots.size).toBe(2);
    expect(runtime.images.has(systemImage)).toBe(true);

    await deleteCheckpoint(host, view.id);

    expect(engine.snapshots.size).toBe(0);
    expect(runtime.images.has(systemImage)).toBe(false);
  });

  test("a snapshot from before checkpoints is listed under a derived id, forked, and deleted, but not changed", async () => {
    const box = await makeBox("alpha");
    const imageId = runtime.seedImage("mbtest-snap:alpha-snap-20261020-000000", {
      [host.keys.snapshot]: "true",
      [host.keys.snapshotOf]: "alpha",
      [host.keys.snapshotOfId]: box.boxId,
      [host.keys.templateName]: "alpha-snap",
      [host.keys.created]: "2026-10-20T00:00:00.000Z",
    });
    const id = legacyCheckpointId(imageId);

    const listed = await listCheckpoints(host);
    expect(listed.find((item) => item.id === id)).toMatchObject({
      legacy: true,
      boxId: box.boxId,
      data: [],
      system: { image: "mbtest-snap:alpha-snap-20261020-000000", imageId },
    });

    const forked = await forkCheckpoint(
      host,
      id,
      { name: "from-snap", cpus: 1, memoryMb: 512, copyHome: false },
      "owner",
    );
    expect(runtime.callsTo("createContainer").at(-1)?.args[0]).toMatchObject({
      image: "mbtest-snap:alpha-snap-20261020-000000",
    });
    expect(forked.name).toBe("from-snap");

    expect(await rejectionOf(updateCheckpoint(host, id, { pinned: true }))).toMatchObject({
      status: 409,
      key: "checkpoint_legacy_read_only",
    });

    expect(tagged("mbtest-snap:alpha-snap-20261020-000000")).toBe(true);

    await deleteCheckpoint(host, id);
    expect(tagged("mbtest-snap:alpha-snap-20261020-000000")).toBe(false);
  });

  test("an unknown id is a not_found", async () => {
    expect(await rejectionOf(getCheckpoint(host, "ck_000000000000000000000000000"))).toMatchObject({
      status: 404,
      key: "checkpoint_not_found",
    });
  });
});
