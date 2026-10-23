import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RuntimeError } from "../src/runtime";
import { CheckpointScheduler, scheduleOf } from "../src/services/checkpoint-schedule";
import { beginChange, beginMove } from "../src/services/moving";
import { createDeclaredTemplate, readRecipe, templateSetupOf } from "../src/services/template-builds";
import { type Cluster, type HostName, bootCluster, boxOn, errorOf } from "./support/cluster";
import { DEVCONTAINER_WITH_SETUP, serveRepository } from "./support/repository";
import { finishedTask } from "./support/tokens";

interface MoveView {
  hostId?: string;
  revision: number;
  boxId: string;
  containerName: string;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** The containers of one box on one host. Each host labels its boxes with its own key, so the key is read per host. */
function containersOf(cluster: Cluster, host: HostName, boxId: string) {
  const key = cluster.app.hosts.get(host).keys.id;
  return [...cluster.engines[host].containers.values()].filter((container) => container.labels[key] === boxId);
}

/** A data volume named `data` on the local host, with one file in it, for a box to mount at `/data`. */
async function dataVolume(cluster: Cluster): Promise<{ engineName: string }> {
  const created = await cluster.post("/api/volumes", { name: "data", confirm: true });
  if (created.status !== 201) throw new Error(`create data: ${created.status} ${await created.text()}`);
  const volume = cluster.app.hosts
    .get()
    .volumes.list()
    .find((record) => record.name === "data");
  if (!volume) throw new Error("the data volume has no record");
  cluster.engines.local.seedVolumeFile(volume.engineName, "notes.txt", {
    type: "file",
    content: Buffer.from("kept"),
    mode: 0o644,
    uid: 1000,
    gid: 1000,
  });
  return volume;
}

describe("moving a box to another host", () => {
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

  async function viewOf(id: string): Promise<MoveView> {
    const res = await cluster.api(`/api/boxes/${id}`);
    return ((await res.json()) as { box: MoveView }).box;
  }

  async function confirmed(id: string, host: string, revision: number): Promise<{ status: string; result?: unknown }> {
    const res = await move(id, { host, confirm: true }, revision);
    expect(res.status).toBe(202);
    const started = (await res.json()) as { taskId: string };
    return finishedTask(cluster.base, started.taskId);
  }

  const templateOn = (host: HostName) => cluster.engines[host].inspectImage(cluster.app.cfg.baseTemplateTag);

  test("without confirm, the answer is a 409 preview, and nothing changes", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    const res = await move(box.boxId, { host: "small" }, box.revision);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("confirmation_required");
    expect(error.details?.preview).toMatchObject({
      from: "local",
      to: "small",
      running: true,
      starts: true,
      image: { transfer: true },
      checkpoints: 0,
      revision: { current: box.revision, next: box.revision + 1 },
    });
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    expect(cluster.engines.small.images.size).toBe(0);
    expect((await viewOf(box.boxId)).hostId).toBe("local");
  });

  test("a confirmed move sends the template, recreates the box on the target and starts it", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    const source = await templateOn("local");
    const done = await confirmed(box.boxId, "small", box.revision);

    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ from: "local", to: "small", checkpoints: 0, leftovers: [] });
    expect((await templateOn("small")).id).toBe(source.id);

    const moved = containersOf(cluster, "small", box.boxId);
    expect(moved.map((container) => container.running)).toEqual([true]);
    expect(containersOf(cluster, "local", box.boxId)).toEqual([]);

    const view = await viewOf(box.boxId);
    expect(view.hostId).toBe("small");
    expect(view.revision).toBe(box.revision + 1);
  });

  test("a checkpoint schedule follows the box: the next run is taken on the host the box moved to", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    const set = await cluster.api(`/api/boxes/${box.boxId}/checkpoint-schedule`, {
      method: "PUT",
      body: JSON.stringify({ everyHours: 1 }),
    });
    expect(set.status).toBe(200);
    expect((await confirmed(box.boxId, "small", box.revision)).status).toBe("succeeded");

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const scheduler = new CheckpointScheduler(
      cluster.app.hosts,
      () => undefined,
      undefined,
      () => later,
    );
    expect(await scheduler.run()).toEqual([box.boxId]);

    const small = cluster.app.hosts.get("small");
    const schedule = await scheduleOf(small, box.boxId);
    expect(schedule).toMatchObject({ hostId: "small", lastRun: { status: "ok" } });
    const taken = small.checkpoints.list().filter((record) => record.boxId === box.boxId);
    expect(taken.map((record) => record.hostId)).toEqual(["small"]);
  });

  test("the source container is removed only after the box runs on the target", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    const hold = cluster.engines.local.hold("removeContainer");
    const res = await move(box.boxId, { host: "small", confirm: true }, box.revision);
    expect(res.status).toBe(202);
    const started = (await res.json()) as { taskId: string };

    await waitFor(() => cluster.engines.local.callsTo("removeContainer").length > 0, "the source removal");
    expect((await viewOf(box.boxId)).hostId).toBe("small");
    expect(containersOf(cluster, "small", box.boxId).map((container) => container.running)).toEqual([true]);

    hold.release();
    expect((await finishedTask(cluster.base, started.taskId)).status).toBe("succeeded");
    expect(containersOf(cluster, "local", box.boxId)).toEqual([]);
  });

  test("local volumes move with the box, with their data, and leave the source", async () => {
    const volume = await dataVolume(cluster);
    const box = await boxOn(cluster, undefined, "dev", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });

    const done = await confirmed(box.boxId, "small", box.revision);
    expect(done.status).toBe("succeeded");

    const local = cluster.app.hosts.get();
    const moved = local.specs.read(box.boxId)?.mounts.find((mount) => mount.path === "/data")?.volume ?? "";
    expect(moved).not.toBe("");
    expect(moved).not.toBe(volume.engineName);
    expect(cluster.engines.small.volumes.has(moved)).toBe(true);
    expect(cluster.engines.small.filesOf(moved).has("notes.txt")).toBe(true);
    expect(cluster.engines.local.volumes.has(volume.engineName)).toBe(false);
    expect(local.volumes.list().some((record) => record.engineName === volume.engineName)).toBe(false);
  });

  test("a move onto a host whose shared tools volume the engine lost recreates it, and the box mounts it there", async () => {
    await boxOn(cluster, "small", "seed", { mounts: undefined });
    const target = cluster.app.hosts.get("small");
    const tools = target.volumes.list().find((volume) => volume.role === "tools" && volume.hostId === target.host.id);
    if (!tools) throw new Error("the small host has no shared tools record");
    cluster.engines.small.volumes.delete(tools.engineName);
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });

    expect((await confirmed(box.boxId, "small", box.revision)).status).toBe("succeeded");
    expect(cluster.engines.small.volumes.has(tools.engineName)).toBe(true);
    expect(target.specs.read(box.boxId)?.mounts.find((mount) => mount.path === "/opt/minibox/tools")?.volume).toBe(
      tools.engineName,
    );
  });

  test("a move off a host whose shared tools volume the engine lost is not refused for it, and the box takes the target's tools", async () => {
    const box = await boxOn(cluster, undefined, "dev", { mounts: undefined });
    const source = cluster.app.hosts.get();
    const tools = source.volumes.list().find((volume) => volume.role === "tools" && volume.hostId === source.host.id);
    if (!tools) throw new Error("the local host has no shared tools record");
    cluster.engines.local.volumes.delete(tools.engineName);

    expect((await confirmed(box.boxId, "small", box.revision)).status).toBe("succeeded");
    const target = cluster.app.hosts.get("small");
    const targetTools = target.volumes
      .list()
      .find((volume) => volume.role === "tools" && volume.hostId === target.host.id);
    if (!targetTools) throw new Error("the small host has no shared tools record");
    expect(target.specs.read(box.boxId)?.mounts.find((mount) => mount.path === "/opt/minibox/tools")?.volume).toBe(
      targetTools.engineName,
    );
    expect(cluster.engines.small.volumes.has(targetTools.engineName)).toBe(true);
  });

  test("a start that fails on the target undoes the move: the box stays on its host and runs", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    cluster.engines.small.fail("startContainer", new RuntimeError("engine", "start refused"));
    const done = await confirmed(box.boxId, "small", box.revision);

    expect(done.status).toBe("failed");
    expect((await viewOf(box.boxId)).hostId).toBe("local");
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
    const source = containersOf(cluster, "local", box.boxId);
    expect(source.map((container) => [container.running, container.paused])).toEqual([[true, false]]);
  });

  test("a target that already has the box's container name takes a suffixed name, and the spec records it", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    const formal = `mbtest-${box.boxId}`;
    cluster.engines.small.seedImage("stray:latest");
    await cluster.engines.small.createContainer({ image: "stray:latest", name: formal, cmd: ["true"] });

    const done = await confirmed(box.boxId, "small", box.revision);
    expect(done.status).toBe("succeeded");

    const containerName = (await viewOf(box.boxId)).containerName;
    expect(containerName).toMatch(new RegExp(`^${formal}-[0-9a-f]{6}$`));
    expect([...cluster.engines.small.containers.values()].map((container) => container.name)).toContain(containerName);
    expect(containersOf(cluster, "small", box.boxId).map((container) => [container.name, container.running])).toEqual([
      [containerName, true],
    ]);
    expect(containersOf(cluster, "local", box.boxId)).toEqual([]);
  });

  test("a volume copy that fails leaves the source volume and its data as they were", async () => {
    const volume = await dataVolume(cluster);
    const box = await boxOn(cluster, undefined, "dev", { mounts: [{ volume: "data", path: "/data", mode: "rw" }] });
    cluster.engines.small.fail("putArchive", new RuntimeError("engine", "disk full"));

    const done = await confirmed(box.boxId, "small", box.revision);
    expect(done.status).toBe("failed");
    expect((await viewOf(box.boxId)).hostId).toBe("local");
    expect(cluster.engines.local.volumes.has(volume.engineName)).toBe(true);
    expect(cluster.engines.local.filesOf(volume.engineName).has("notes.txt")).toBe(true);
    expect(cluster.engines.small.volumes.size).toBe(0);
    expect(
      cluster.app.hosts
        .get()
        .volumes.list()
        .filter((record) => record.hostId === "small"),
    ).toEqual([]);
  });

  test("while a move runs, a second move, an update and a rebuild of the box are refused", async () => {
    const box = await boxOn(cluster, undefined, "dev");
    const hold = cluster.engines.local.hold("saveImage");
    const res = await move(box.boxId, { host: "small", confirm: true }, box.revision);
    expect(res.status).toBe(202);
    const started = (await res.json()) as { taskId: string };
    await waitFor(() => cluster.engines.local.callsTo("saveImage").length > 0, "the image transfer");

    const update = await cluster.api(`/api/boxes/${box.boxId}`, {
      method: "PATCH",
      headers: { "if-match": String(box.revision) },
      body: JSON.stringify({ memoryMb: 512 }),
    });
    expect(await errorOf(update)).toMatchObject({ key: "box_moving" });

    const rebuild = await cluster.api(`/api/boxes/${box.boxId}/rebuild`, {
      method: "POST",
      headers: { "if-match": String(box.revision) },
      body: JSON.stringify({ profile: "relaxed", confirm: true }),
    });
    expect(await errorOf(rebuild)).toMatchObject({ key: "box_moving" });

    const again = await move(box.boxId, { host: "small", confirm: true }, box.revision);
    expect(again.status).toBe(409);

    hold.release();
    expect((await finishedTask(cluster.base, started.taskId)).status).toBe("succeeded");
  });

  test("a stale revision, the box's own host and an unknown host are refused before anything starts", async () => {
    const box = await boxOn(cluster, undefined, "dev");

    const stale = await move(box.boxId, { host: "small", confirm: true }, box.revision + 5);
    expect(stale.status).toBe(412);
    expect((await errorOf(stale)).key).toBe("revision_mismatch");

    const same = await move(box.boxId, { host: "local", confirm: true }, box.revision);
    expect(same.status).toBe(400);
    expect((await errorOf(same)).key).toBe("move_same_host");

    const unknown = await move(box.boxId, { host: "nowhere", confirm: true }, box.revision);
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).key).toBe("host_not_found");
    expect(containersOf(cluster, "small", box.boxId)).toEqual([]);
  });

  test("a template the box follows that has moved on is refused, and so is a tag the target holds for another image", async () => {
    const moved = await boxOn(cluster, undefined, "moved");
    cluster.engines.local.moveTag(cluster.app.cfg.baseTemplateTag);
    const res = await move(moved.boxId, { host: "small" }, moved.revision);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).key).toBe("move_template_moved");

    const differs = await boxOn(cluster, undefined, "differs");
    cluster.engines.small.seedImage(cluster.app.cfg.baseTemplateTag);
    const other = await move(differs.boxId, { host: "small" }, differs.revision);
    expect(other.status).toBe(409);
    expect((await errorOf(other)).key).toBe("move_template_differs");
    expect(containersOf(cluster, "small", differs.boxId)).toEqual([]);
  });

  describe("a box made from a declared template with a setup", () => {
    beforeEach(async () => {
      serveRepository(cluster.engines.local, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
      await createDeclaredTemplate(
        cluster.app.hosts.get(),
        { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
        {},
      );
    });

    test("the target gets the template's recipe with the image, so its template keeps the setup", async () => {
      const box = await boxOn(cluster, "local", "alpha", { template: "mbtest-template:dev" });
      const view = await viewOf(box.id);
      expect(await confirmed(box.id, "small", view.revision)).toMatchObject({ status: "succeeded" });

      expect(readRecipe(cluster.app.hosts.get("small"), "dev")).toEqual(readRecipe(cluster.app.hosts.get(), "dev"));
      expect(await templateSetupOf(cluster.app.hosts.get("small"), "mbtest-template:dev")).toEqual({
        postCreate: ["/bin/sh", "-c", "npm install"],
        forwardPorts: [3000],
      });
    });
  });
});

/** The message key of the refusal `fn` throws. A call that does not throw fails the test. */
function refusalKey(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { key?: string }).key;
  }
  throw new Error("expected a refusal, but the call returned");
}

describe("a move and a change of one box refuse each other", () => {
  test("a box being changed cannot start a move, and a moving box cannot be changed", () => {
    const releaseChange = beginChange("box_guard_a");
    expect(refusalKey(() => beginMove("box_guard_a"))).toBe("box_changing");
    releaseChange();

    const releaseMove = beginMove("box_guard_a");
    expect(refusalKey(() => beginChange("box_guard_a"))).toBe("box_moving");
    releaseMove();
    expect(() => beginChange("box_guard_a")()).not.toThrow();
  });

  test("two changes of one box can overlap, and the box is free once both end", () => {
    const first = beginChange("box_guard_b");
    const second = beginChange("box_guard_b");
    first();
    expect(refusalKey(() => beginMove("box_guard_b"))).toBe("box_changing");
    second();
    beginMove("box_guard_b")();
  });
});
