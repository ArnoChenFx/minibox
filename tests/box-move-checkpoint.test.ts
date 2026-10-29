import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import { moveBoxByCheckpoint } from "../src/services/move-checkpoint";
import type { CheckpointView } from "../src/services/checkpoint-model";
import { type Cluster, bootCluster, boxOn, errorOf } from "./support/cluster";
import type { FakeRuntime } from "./support/fake-runtime";
import { finishedTask } from "./support/tokens";

interface MoveBody {
  hostId?: string;
  revision: number;
  boxId: string;
  containerName: string;
}

interface Preview {
  via?: string;
  from?: string;
  to?: string;
  running?: boolean;
  starts?: boolean;
  image?: { ref: string; transfer: boolean };
  volumes?: { path: string; role: string | null; name: string; action: string; target: string | null }[];
  checkpoints?: number;
  revision?: { current: number; next: number };
}

interface TaskResult {
  status: string;
  result?: {
    box?: { hostId?: string };
    from?: string;
    to?: string;
    via?: string;
    checkpoints?: number;
    leftovers?: { kind: string; name: string }[];
  };
  error?: { key?: string };
}

const MB = 1024 * 1024;

/** The containers of one box on one host. Each host labels its boxes with its own key, so the key is read per host. */
function containersOf(cluster: Cluster, host: "local" | "small", boxId: string) {
  const key = cluster.app.hosts.get(host).keys.id;
  return [...cluster.engines[host].containers.values()].filter((container) => container.labels[key] === boxId);
}

function filesOf(runtime: FakeRuntime, volume: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, entry] of runtime.filesOf(volume)) {
    if (path !== "" && entry.type === "file") files[path] = entry.content?.toString() ?? "";
  }
  return files;
}

/** Every checkpoint of a box on a host, as the checkpoint store holds it. */
function checkpointsOn(cluster: Cluster, host: "local" | "small", boxId: string): CheckpointView[] {
  return cluster.app.hosts
    .get(host)
    .checkpoints.list()
    .filter((record) => record.boxId === boxId && record.hostId === host && record.trash === null)
    .map((record) => ({
      id: record.id,
      legacy: false,
      hostId: record.hostId,
      boxId: record.boxId,
      boxName: record.boxName,
      label: record.label,
      reason: record.reason,
      createdBy: record.createdBy,
      pinned: record.pinned,
      auto: record.auto,
      consistency: record.consistency,
      specRevision: record.specRevision,
      spec: record.spec,
      data: record.data,
      system: record.system,
      bytes: record.data.reduce((sum, layer) => sum + layer.bytes, 0),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
}

describe("moving a box through a checkpoint", () => {
  let cluster: Cluster;

  beforeEach(async () => {
    cluster = await bootCluster({}, ["local"]);
  });

  afterEach(() => {
    cluster.close();
  });

  const move = (id: string, body: Record<string, unknown>, revision?: number) =>
    cluster.api(`/api/boxes/${id}/move`, {
      method: "POST",
      headers: revision === undefined ? {} : { "if-match": String(revision) },
      body: JSON.stringify(body),
    });

  async function viewOf(id: string): Promise<MoveBody> {
    const res = await cluster.api(`/api/boxes/${id}`);
    return ((await res.json()) as { box: MoveBody }).box;
  }

  async function confirmed(id: string, body: Record<string, unknown>, revision: number): Promise<TaskResult> {
    const res = await move(id, { ...body, confirm: true }, revision);
    expect(res.status).toBe(202);
    const started = (await res.json()) as { taskId: string };
    return (await finishedTask(cluster.base, started.taskId)) as TaskResult;
  }

  /** A volume named `data` on the local host with one file in it, for a box to mount at `/data`. */
  async function dataVolume(cluster: Cluster): Promise<string> {
    const created = await cluster.post("/api/volumes", { name: "data", confirm: true });
    if (created.status !== 201) throw new Error(`create data: ${created.status} ${await created.text()}`);
    const record = cluster.app.hosts
      .get()
      .volumes.list()
      .find((volume) => volume.name === "data");
    if (!record) throw new Error("the data volume has no record");
    cluster.engines.local.seedVolumeFile(record.engineName, "notes.txt", {
      type: "file",
      content: Buffer.from("kept"),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    });
    return record.engineName;
  }

  test("without confirm, the answer is a 409 preview of the checkpoint path, and nothing changes", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const res = await move(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("confirmation_required");
    expect(error.key).toBe("move_confirm_checkpoint");
    const preview = error.details?.preview as Preview;
    expect(preview).toMatchObject({
      via: "checkpoint",
      from: "local",
      to: "small",
      running: true,
      starts: true,
      image: { transfer: true },
      checkpoints: 0,
      revision: { current: box.revision, next: box.revision + 1 },
    });
    // The box's four role volumes: workspace and home travel in the checkpoint, the target's tools volume replaces
    // this one, and cache is made again empty.
    expect(preview.volumes?.map((volume) => [volume.path, volume.action])).toEqual([
      ["/workspace", "checkpoint"],
      ["/home/dev", "checkpoint"],
      ["/opt/minibox/tools", "tools"],
      ["/home/dev/.cache", "empty"],
    ]);
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    expect(cluster.app.hosts.get().checkpoints.list().filter((record) => record.boxId === box.boxId)).toEqual([]);
    expect((await viewOf(box.boxId)).hostId).toBe("local");
  });

  test("a confirmed move carries the box's data in a checkpoint, makes the box on the target and removes it here", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision);

    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ from: "local", to: "small", via: "checkpoint", checkpoints: 0, leftovers: [] });

    const moved = containersOf(cluster, "small", box.boxId);
    expect(moved.map((container) => container.running)).toEqual([true]);
    expect(containersOf(cluster, "local", box.boxId)).toEqual([]);

    const view = await viewOf(box.boxId);
    expect(view.hostId).toBe("small");
    expect(view.revision).toBe(box.revision + 1);

    // The two checkpoints the move made are removed once the box runs on the target.
    expect(checkpointsOn(cluster, "local", box.boxId)).toEqual([]);
    expect(checkpointsOn(cluster, "small", box.boxId)).toEqual([]);
  });

  test("a volume's data arrives in the restored volume on the target, and the source volume is removed", async () => {
    const source = await dataVolume(cluster);
    const box = await boxOn(cluster, undefined, "dev", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });

    expect((await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision)).status).toBe("succeeded");

    const local = cluster.app.hosts.get();
    const moved = local.specs.read(box.boxId)?.mounts.find((mount) => mount.path === "/data")?.volume ?? "";
    expect(moved).not.toBe("");
    expect(moved).not.toBe(source);
    expect(cluster.engines.small.volumes.has(moved)).toBe(true);
    expect(filesOf(cluster.engines.small, moved)).toEqual({ "notes.txt": "kept" });
    expect(cluster.engines.local.volumes.has(source)).toBe(false);
    expect(local.volumes.list().some((record) => record.engineName === source)).toBe(false);
  });

  test("a stopped box stays stopped on the target, and the container is created without a start", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const stopped = await cluster.api(`/api/boxes/${box.boxId}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    const revision = (await viewOf(box.boxId)).revision;

    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, revision);
    expect(done.status).toBe("succeeded");
    expect(containersOf(cluster, "small", box.boxId).map((container) => container.running)).toEqual([false]);
  });

  test("a template the target lacks is carried by the checkpoint copy, so the box is made from it", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(done.status).toBe("succeeded");
    const image = cluster.engines.small.inspectImage(cluster.app.cfg.baseTemplateTag);
    expect(await image).toBeDefined();
  });

  test("a target that cannot get the template refuses the move before a checkpoint is taken", async () => {
    // The base template is only on the local host, and the local host cannot send it when its own copy is gone.
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    cluster.engines.local.images.clear();
    const res = await move(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).key).toBe("template_image_missing");
    expect(cluster.app.hosts.get().checkpoints.list()).toEqual([]);
    expect((await viewOf(box.boxId)).hostId).toBe("local");
  });

  test("a checkpoint copy that fails leaves the box on its host and takes back the checkpoint it took", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    cluster.engines.small.fail("loadImage", new RuntimeError("engine", "disk full"));
    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision);

    expect(done.status).toBe("failed");
    expect((await viewOf(box.boxId)).hostId).toBe("local");
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    expect(containersOf(cluster, "local", box.boxId).map((container) => container.running)).toEqual([true]);
    expect(checkpointsOn(cluster, "local", box.boxId)).toEqual([]);
    expect(checkpointsOn(cluster, "small", box.boxId)).toEqual([]);
  });

  test("a backup that fails refuses the move and leaves the box as it was", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const source = cluster.app.hosts.get();
    const workspace = source.specs.read(box.boxId)?.mounts.find((mount) => mount.path === "/workspace")?.volume ?? "";
    const engine = cluster.checkpointEngine();
    engine.failBackupOf.add(workspace);
    expect(workspace).not.toBe("");

    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(done.status).toBe("failed");
    expect((await viewOf(box.boxId)).hostId).toBe("local");
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    expect(checkpointsOn(cluster, "local", box.boxId)).toEqual([]);
    expect(containersOf(cluster, "local", box.boxId).map((container) => [container.running, container.paused])).toEqual([
      [true, false],
    ]);
  });

  test("a box that cannot be created on the target leaves the source box and its volumes untouched", async () => {
    const source = await dataVolume(cluster);
    const box = await boxOn(cluster, undefined, "dev", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });
    cluster.engines.small.fail("createContainer", new RuntimeError("engine", "no such volume"));

    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(done.status).toBe("failed");
    expect((await viewOf(box.boxId)).hostId).toBe("local");
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    expect(containersOf(cluster, "local", box.boxId).map((container) => [container.running, container.paused])).toEqual([
      [true, false],
    ]);
    expect(cluster.engines.local.volumes.has(source)).toBe(true);
    expect(filesOf(cluster.engines.local, source)).toEqual({ "notes.txt": "kept" });
    expect(checkpointsOn(cluster, "local", box.boxId)).toEqual([]);
    expect(checkpointsOn(cluster, "small", box.boxId)).toEqual([]);
    expect(cluster.app.hosts.get("small").volumes.list().filter((record) => record.hostId === "small")).toEqual([]);
  });

  test("a start that fails on the target undoes the move and resumes the source", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    cluster.engines.small.fail("startContainer", new RuntimeError("engine", "start refused"));
    const done = await confirmed(box.boxId, { host: "small", via: "checkpoint" }, box.revision);

    expect(done.status).toBe("failed");
    expect((await viewOf(box.boxId)).hostId).toBe("local");
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    expect(containersOf(cluster, "local", box.boxId).map((container) => [container.running, container.paused])).toEqual([
      [true, false],
    ]);
    expect(checkpointsOn(cluster, "local", box.boxId)).toEqual([]);
  });

  test("a volume a checkpoint cannot read refuses the checkpoint path, and says which volume and path", async () => {
    // A volume with checkpoint off stands in for one a checkpoint never reads. The message names the volume and the
    // path it is mounted at, so the operator knows which mount to change or move with via direct.
    const data = await dataVolume(cluster);
    const box = await boxOn(cluster, undefined, "dev", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });
    const source = cluster.app.hosts.get();
    const record = source.volumes.findByEngine("local", data);
    if (!record) throw new Error("the data volume has no record");
    source.volumes.write({ ...record, checkpoint: false });

    const res = await move(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.key).toBe("move_checkpoint_volume_unrepresentable");
    expect(error.params).toMatchObject({ volume: record.name, path: "/data" });
    expect(error.message).toContain("via direct");
    expect(cluster.app.hosts.get().checkpoints.list()).toEqual([]);
    expect((await viewOf(box.boxId)).hostId).toBe("local");
  });

  test("a volume another box also mounts refuses the checkpoint path", async () => {
    const shared = await dataVolume(cluster);
    const first = await boxOn(cluster, undefined, "one", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });
    const second = await boxOn(cluster, undefined, "two", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });

    const res = await move(second.boxId, { host: "small", via: "checkpoint" }, second.revision);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.key).toBe("move_shared_volume");
    expect(error.params).toMatchObject({ volume: "data" });
    expect((await viewOf(first.boxId)).hostId).toBe("local");
    expect((await viewOf(second.boxId)).hostId).toBe("local");
    expect(cluster.app.hosts.get().checkpoints.list()).toEqual([]);
    expect(cluster.engines.local.volumes.has(shared)).toBe(true);
  });

  test("the same volume mounted twice refuses the checkpoint path, because a package carries one snapshot per volume", async () => {
    await dataVolume(cluster);
    const box = await boxOn(cluster, undefined, "dev", {
      mounts: [
        { volume: "data", path: "/data", mode: "rw" },
        { volume: "data", path: "/data-copy", mode: "ro" },
      ],
    });
    const res = await move(box.boxId, { host: "small", via: "checkpoint" }, box.revision);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).key).toBe("move_checkpoint_volume_unrepresentable");
    expect(cluster.app.hosts.get().checkpoints.list()).toEqual([]);
  });

  test("an agent host on the target refuses the move and says why", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const local = cluster.app.hosts.get();
    const edge = {
      ...local,
      host: { ...local.host, id: "edge", transport: "agent" as const, endpoint: "agent://edge" },
    };
    const res = await moveBoxByCheckpoint(local, edge, box.boxId, box.revision, [], undefined).catch((e: unknown) => e);
    expect(res).toBeInstanceOf(AppError);
    const error = res as AppError;
    expect(error.status).toBe(501);
    expect(error.code).toBe("unsupported");
    expect(error.key).toBe("move_agent_unsupported");
    expect(error.message).toContain("An agent does not copy images, volumes or archives");
    expect(checkpointsOn(cluster, "local", box.boxId)).toEqual([]);
    expect(containersOf(cluster, "local", box.boxId).map((container) => container.paused)).toEqual([false]);
  });

  test("a move through a checkpoint refuses a stale revision and the box's own host before anything starts", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });

    const stale = await move(box.boxId, { host: "small", via: "checkpoint", confirm: true }, box.revision + 5);
    expect(stale.status).toBe(412);
    expect((await errorOf(stale)).key).toBe("revision_mismatch");

    const same = await move(box.boxId, { host: "local", via: "checkpoint", confirm: true }, box.revision);
    expect(same.status).toBe(400);
    expect((await errorOf(same)).key).toBe("move_same_host");

    expect(cluster.app.hosts.get().checkpoints.list()).toEqual([]);
  });

  test("while a checkpoint move runs, a second move of the box is refused", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const engine = cluster.checkpointEngine();
    const hold = engine.hold("backup");
    const res = await move(box.boxId, { host: "small", via: "checkpoint", confirm: true }, box.revision);
    expect(res.status).toBe(202);
    const started = (await res.json()) as { taskId: string };

    const deadline = Date.now() + 5000;
    while (hold.blocked() === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the checkpoint backup");
      await Bun.sleep(5);
    }

    // The move holds the box's task mutex, so a second move is refused before it starts anything.
    const again = await move(box.boxId, { host: "small", via: "checkpoint", confirm: true }, box.revision);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).key).toBe("task_busy");

    hold.release();
    expect((await finishedTask(cluster.base, started.taskId)).status).toBe("succeeded");
  });

  test("a direct move still leaves the box's checkpoints on the source, and reports the path it took", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const taken = await cluster.post(`/api/boxes/${box.boxId}/checkpoints`, { label: "before" });
    expect(taken.status).toBe(202);
    await finishedTask(cluster.base, ((await taken.json()) as { taskId: string }).taskId);
    expect(checkpointsOn(cluster, "local", box.boxId)).toHaveLength(1);

    const done = await confirmed(box.boxId, { host: "small" }, box.revision);
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ via: "direct", checkpoints: 1 });
    expect(checkpointsOn(cluster, "local", box.boxId)).toHaveLength(1);
  });
});
