import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { statSync } from "node:fs";

import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { ExecutorHooks } from "../src/operations/executor";
import type { OperationContext } from "../src/operations/types";
import { type HelperSpec, RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { reconcileHost } from "../src/services/reconcile";
import { attachVolume, createVolume, getPools, listVolumes, measureVolume, savePools } from "../src/services/volumes";
import { claimEngineVolumes } from "../src/volumes/engine";
import { DEV_OWNER } from "../src/volumes/types";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const mode = (path: string) => statSync(path).mode & 0o777;

let runtime: FakeRuntime;
let host: HostCtx;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  runtime = created.runtime;
  host = created.app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true" });
});

const newBox = (name: string, extra: Partial<Parameters<typeof boxes.createBox>[1]> = {}) =>
  boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...extra });

describe("volumes and storage pools", () => {
  test("an independent volume mounts on two boxes and survives deleting either box", async () => {
    const shared = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const alpha = await newBox("alpha");
    const beta = await newBox("beta");
    const first = await attachVolume(host, shared.id, {
      box: alpha.boxId,
      path: "/srv/notes",
      mode: "rw",
      revision: alpha.revision,
      confirm: true,
    });
    expect(first.warning).toBeNull();
    const second = await attachVolume(host, shared.id, {
      box: beta.boxId,
      path: "/srv/notes",
      mode: "rw",
      revision: beta.revision,
      confirm: true,
    });
    expect(second.warning).toBe("shared_rw");
    expect(second.box.mounts.some((mount) => mount.path === "/srv/notes" && mount.mode === "rw")).toBe(true);

    expect((await boxes.deleteBox(host, alpha.boxId, true)).volumeDeleted).toBe(true);
    expect(host.volumes.read(shared.id)?.name).toBe("notes");
    expect(runtime.volumes.has(shared.engineName)).toBe(true);
    const still = await boxes.getBox(host, beta.boxId);
    expect(still.mounts.some((mount) => mount.volumeId === shared.id)).toBe(true);
  });

  test("a default NFS pool places workspace, home and tools on NFS and cache on local", async () => {
    await savePools(
      host,
      [
        { name: "local", backend: "local" },
        {
          name: "nas",
          backend: "nfs",
          server: "192.168.1.10",
          export: "/volume1/minibox",
          options: ["nfsvers=4.1", "hard"],
          default: true,
        },
      ],
      undefined,
    );
    const box = await newBox("alpha");
    const byRole = Object.fromEntries(box.mounts.map((mount) => [mount.role, mount]));
    expect(byRole.workspace?.pool).toBe("nas");
    expect(byRole.home?.pool).toBe("nas");
    expect(byRole.tools?.pool).toBe("nas");
    expect(byRole.tools?.mode).toBe("ro");
    expect(byRole.cache?.pool).toBe("local");

    const workspace = runtime.volumes.get(byRole.workspace?.volume ?? "");
    expect(workspace?.options).toMatchObject({
      type: "nfs",
      o: "addr=192.168.1.10,nfsvers=4.1,hard",
      device: `:/volume1/minibox/${byRole.workspace?.volume}`,
    });
    expect(runtime.volumes.get(byRole.cache?.volume ?? "")?.options).toBeUndefined();
    expect(runtime.volumes.get("mbtest-pool-nas")?.options?.o).toContain("soft");
    expect(runtime.volumes.get("mbtest-pool-nas")?.options?.o).not.toContain("hard");
  });

  test("a path pool without its marker is unreachable and a new box is refused", async () => {
    runtime.helperHandler = (spec: HelperSpec) => {
      if (spec.cmd.join(" ").includes("test -f")) return { exitCode: 1, logs: "missing marker" };
      return { exitCode: 0, logs: "" };
    };
    await savePools(
      host,
      [
        { name: "local", backend: "local" },
        { name: "disk", backend: "path", root: "/mnt/disk", marker: ".minibox-mounted", default: true },
      ],
      undefined,
    );
    const error = await rejectionOf(newBox("alpha"));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 503, key: "storage_unreachable" });
    expect(runtime.containers.size).toBe(0);

    const pools = await getPools(host);
    expect(pools.health.find((item) => item.pool === "disk")).toMatchObject({
      status: "unreachable",
    });
    expect(pools.health.find((item) => item.pool === "disk")?.message).toContain(".minibox-mounted");
  });

  test("an existing minibox-ws-* volume is recognized and is not relabelled or removed", async () => {
    runtime.volumes.set("mbtest-ws-kept", { name: "mbtest-ws-kept", labels: { keep: "yes" } });
    const found = await listVolumes(host);
    const claimed = found.find((volume) => volume.engineName === "mbtest-ws-kept");
    expect(claimed).toMatchObject({ role: "workspace", ownership: "independent", pool: "local" });
    expect(runtime.volumes.get("mbtest-ws-kept")?.labels).toEqual({ keep: "yes" });
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
  });

  test("volume:attach can refuse an existing volume without blocking the owner by default", async () => {
    const hooks: Partial<ExecutorHooks> = {
      authorize: (request) => request.scope !== "volume:attach",
    };
    const denied = createTestApp({ labelPrefix: "mbtest" }, new FakeRuntime(), hooks);
    denied.runtime.seedImage(denied.app.hosts.get().baseTemplateTag, {});
    const ctx: OperationContext = {
      host: denied.app.hosts.get(),
      principal: { type: "owner", id: "owner", name: "owner" },
      source: "rest",
      events: denied.app.events,
    };
    await denied.app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
    const error = await rejectionOf(
      denied.app.operations.run("box.create", ctx, { name: "beta", cpus: 1, memoryMb: 256 }),
    );
    expect(error).toMatchObject({ status: 403, key: "volume_attach_forbidden" });
    expect(denied.runtime.containers.size).toBe(1);

    const notes = await createVolume(denied.app.hosts.get(), { name: "notes", role: null, createdBy: "owner" });
    const explicit = await rejectionOf(
      denied.app.operations.run("box.create", ctx, {
        name: "gamma",
        cpus: 1,
        memoryMb: 256,
        mounts: [{ volume: notes.id, path: "/srv/notes", mode: "ro" }],
      }),
    );
    expect(explicit).toMatchObject({ status: 403, key: "volume_attach_forbidden" });
    expect(denied.runtime.containers.size).toBe(1);
  });

  test("a mount change rebuilds the container under prefix-id and chowns new local volumes as root", async () => {
    const box = await newBox("alpha");
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const chown = runtime.callsTo("runHelper").map((call) => call.args[0] as HelperSpec);
    expect(chown.some((spec) => spec.user === "0:0" && spec.cmd.join(" ").includes("chown"))).toBe(true);

    const next = await attachVolume(host, notes.id, {
      box: box.id,
      path: "/srv/notes",
      mode: "ro",
      revision: box.revision,
      confirm: true,
    });
    expect(next.box.containerName).toBe(`${host.prefix}-${box.boxId}`);
    expect(next.box.id).not.toBe(box.id);
    expect(runtime.containers.has(box.id)).toBe(false);
    expect(next.box.revision).toBe(box.revision + 1);
  });

  test("an empty mounts list creates a box with no volumes", async () => {
    const box = await newBox("bare", { mounts: [] });
    expect(box.mounts).toEqual([]);
    expect(box.volume).toBe("");
    expect(runtime.volumes.size).toBe(0);
  });

  test("low free space is flagged and volume files are mode 600 under a mode 700 directory", async () => {
    runtime.disk = { totalBytes: 100_000_000_000, freeBytes: 1024 };
    const pools = await getPools(host, { force: true });
    expect(pools.health.find((item) => item.pool === "local")).toMatchObject({ status: "reachable", lowSpace: true });

    await newBox("alpha");
    const record = host.volumes.list().find((volume) => volume.role === "workspace");
    expect(record).toBeTruthy();
    expect(mode(host.volumes.dir())).toBe(0o700);
    expect(mode(host.volumes.pathFor(record?.id ?? ""))).toBe(0o600);
    await savePools(host, [{ name: "local", backend: "local", default: true }], undefined);
    expect(mode(host.volumes.poolsPath())).toBe(0o600);
  });

  test("reconcile logs an unreachable pool instead of failing startup", async () => {
    runtime.helperHandler = () => ({
      exitCode: 0,
      logs: "Filesystem 1B-blocks Used Available Use% Mounted\nfake 100 1 80 1% /mnt\n",
    });
    await savePools(
      host,
      [
        { name: "local", backend: "local" },
        { name: "disk", backend: "path", root: "/mnt/disk", default: true },
      ],
      undefined,
    );
    const box = await newBox("alpha");
    await runtime.stopContainer(box.id, { timeoutSec: 1 });
    const known = host.volumes.healthOf(host.host.id, "disk");
    expect(known).toBeTruthy();
    host.volumes.rememberHealth({ ...known!, checkedAt: new Date(0).toISOString() });
    runtime.helperHandler = (spec) =>
      spec.cmd.join(" ").includes("test -f") ? { exitCode: 1, logs: "missing" } : { exitCode: 0, logs: "" };

    const report = await reconcileHost(host);
    expect(report.started).toEqual([]);
    expect(runtime.containers.get(box.id)?.running).toBe(false);
  });
});

const managed = (name: string) => ({ [host.keys.box]: "true", [host.keys.name]: name });

describe("a failed create gives back what it made", () => {
  test("a failed container create removes every volume, record and the spec", async () => {
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));

    expect(await rejectionOf(newBox("alpha"))).toMatchObject({ kind: "engine" });
    expect(runtime.volumes.size).toBe(0);
    expect(host.volumes.list()).toEqual([]);
    expect(host.specs.findByName("alpha")).toBeNull();
    expect(runtime.containers.size).toBe(0);
  });

  test("a failed start also removes the container it created", async () => {
    runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));

    expect(await rejectionOf(newBox("alpha"))).toMatchObject({ kind: "engine" });
    expect(runtime.containers.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect(host.volumes.list()).toEqual([]);
    expect(host.specs.findByName("alpha")).toBeNull();
  });

  const nasPool = [
    { name: "local", backend: "local" as const },
    {
      name: "nas",
      backend: "nfs" as const,
      server: "192.168.1.10",
      export: "/volume1/minibox",
      options: ["nfsvers=4.1", "hard"],
      default: true,
    },
  ];

  test("an NFS pool's root and the subdirectories this create made are removed, and the directories by rmdir", async () => {
    await savePools(host, nasPool, undefined);
    runtime.volumes.delete("mbtest-pool-nas");
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));

    await rejectionOf(newBox("alpha"));
    expect(runtime.volumes.size).toBe(0);
    expect(host.volumes.list()).toEqual([]);
    const rmdirs = runtime
      .callsTo("runHelper")
      .map((call) => (call.args[0] as HelperSpec).cmd.join(" "))
      .filter((cmd) => cmd.includes("rmdir"));
    expect(rmdirs).toHaveLength(3);
  });

  test("an NFS pool root that was already there is kept when a create on that pool fails", async () => {
    await savePools(host, nasPool, undefined);
    expect(runtime.volumes.has("mbtest-pool-nas")).toBe(true);
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));

    await rejectionOf(newBox("alpha"));
    expect([...runtime.volumes.keys()]).toEqual(["mbtest-pool-nas"]);
    expect(host.volumes.list()).toEqual([]);
  });

  test("a container the engine will not remove keeps its spec and volumes, so nothing in use loses its record", async () => {
    runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));
    runtime.fail("removeContainer", new RuntimeError("engine", "busy", "busy"));

    await rejectionOf(newBox("alpha"));
    expect(runtime.containers.size).toBe(1);
    expect(host.specs.findByName("alpha")).not.toBeNull();
    expect(runtime.volumes.size).toBe(4);
    expect(host.volumes.list()).toHaveLength(4);
  });

  test("a legacy workspace the box adopted gets its earlier record back", async () => {
    runtime.volumes.set("mbtest-ws-kept", { name: "mbtest-ws-kept", labels: managed("kept") });
    await claimEngineVolumes(host);
    const before = host.volumes.resolve("mbtest-ws-kept", host.host.id);
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));

    await rejectionOf(newBox("kept"));
    expect(host.volumes.resolve("mbtest-ws-kept", host.host.id)).toEqual(before);
    expect(runtime.volumes.has("mbtest-ws-kept")).toBe(true);
  });

  test("a legacy workspace with no record loses the one the attempt added, and the engine volume stays", async () => {
    runtime.volumes.set("mbtest-ws-plain", { name: "mbtest-ws-plain", labels: managed("plain") });
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));

    await rejectionOf(newBox("plain"));
    expect(host.volumes.list().some((volume) => volume.engineName === "mbtest-ws-plain")).toBe(false);
    expect(runtime.volumes.has("mbtest-ws-plain")).toBe(true);
  });

  test("a successful create adopts the legacy workspace as an owned record", async () => {
    runtime.volumes.set("mbtest-ws-plain", { name: "mbtest-ws-plain", labels: managed("plain") });

    const box = await newBox("plain");
    expect(box.mounts).toContainEqual(expect.objectContaining({ volume: "mbtest-ws-plain", role: "workspace" }));
    expect(host.volumes.findByEngine(host.host.id, "mbtest-ws-plain")).toMatchObject({
      ownership: "owned",
      ownerBoxId: box.boxId,
    });
  });

  test("an engine volume that already has the id the attempt picked is refused and left alone", async () => {
    const id = "vol_collide01";
    runtime.volumes.set(id, { name: id, labels: { keep: "me" } });
    const allocate = spyOn(host.volumes, "allocateId").mockReturnValue(id);
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(newBox("alpha"));
    expect(error).toMatchObject({ status: 409, key: "volume_engine_exists", params: { volume: id } });
    expect(runtime.volumes.get(id)?.labels).toEqual({ keep: "me" });
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(host.volumes.list()).toEqual([]);
    allocate.mockRestore();
  });
});

describe("the shared tools volume", () => {
  test("is named for its host, so a second host creates its own", async () => {
    await newBox("alpha");
    const second: HostCtx = { ...host, host: { ...host.host, id: "nas-1" } };
    await boxes.createBox(second, { name: "beta", cpus: 1, memoryMb: 256 });

    const tools = host.volumes
      .list()
      .filter((volume) => volume.role === "tools")
      .map((volume) => [volume.hostId, volume.name]);
    expect(tools).toHaveLength(2);
    expect(tools).toContainEqual(["local", "mbtest-tools-local"]);
    expect(tools).toContainEqual(["nas-1", "mbtest-tools-nas-1"]);
  });

  test("an existing tools volume is reused whatever its name", async () => {
    await createVolume(host, { name: "mbtest-tools", role: "tools", createdBy: "owner" });
    const box = await newBox("alpha");

    expect(box.mounts.find((mount) => mount.role === "tools")).toMatchObject({
      volumeName: "mbtest-tools",
      mode: "ro",
    });
    expect(host.volumes.list().filter((volume) => volume.role === "tools")).toHaveLength(1);
  });
});

describe("a volume the engine lost is refused, not recreated", () => {
  test("starting or restarting a box whose volume is gone is a conflict, and the engine is not asked to start it", async () => {
    const box = await newBox("alpha");
    await boxes.stopBox(host, box.id);
    runtime.volumes.delete(box.volume);
    const starts = runtime.callsTo("startContainer").length;
    const restarts = runtime.callsTo("restartContainer").length;

    expect(await rejectionOf(boxes.startBox(host, box.id))).toMatchObject({
      status: 409,
      key: "volume_missing",
      params: { volume: "alpha-workspace" },
    });
    expect(await rejectionOf(boxes.restartBox(host, box.id))).toMatchObject({ status: 409, key: "volume_missing" });
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(runtime.callsTo("restartContainer")).toHaveLength(restarts);
    expect(runtime.volumes.has(box.volume)).toBe(false);
    expect((await boxes.getBox(host, box.id)).running).toBe(false);
  });

  test("reconcile reports the box whose volume is gone as failed and still starts the others", async () => {
    const lost = await newBox("lost");
    const fine = await newBox("fine");
    await runtime.stopContainer(lost.id, { timeoutSec: 1 });
    await runtime.stopContainer(fine.id, { timeoutSec: 1 });
    runtime.volumes.delete(lost.volume);

    const report = await reconcileHost(host);
    expect(report.failed).toEqual([{ id: lost.boxId, error: expect.stringContaining("no longer exists") }]);
    expect(report.started).toEqual([fine.boxId]);
    expect(runtime.volumes.has(lost.volume)).toBe(false);
  });

  test("measuring a standalone volume the engine lost is refused before a helper could create it", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    runtime.volumes.delete(notes.engineName);
    const helpers = runtime.callsTo("runHelper").length;

    expect(await rejectionOf(measureVolume(host, notes.id))).toMatchObject({
      status: 409,
      key: "volume_missing",
      params: { volume: "notes" },
    });
    expect(runtime.callsTo("runHelper")).toHaveLength(helpers);
    expect(runtime.volumes.has(notes.engineName)).toBe(false);
  });

  test("attaching a standalone volume the engine lost is refused and no container is created", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const box = await newBox("alpha");
    runtime.volumes.delete(notes.engineName);
    const creates = runtime.callsTo("createContainer").length;

    expect(
      await rejectionOf(
        attachVolume(host, notes.id, {
          box: box.boxId,
          path: "/srv/notes",
          mode: "rw",
          revision: box.revision,
          confirm: true,
        }),
      ),
    ).toMatchObject({ status: 409, key: "volume_missing", params: { volume: "notes" } });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.volumes.has(notes.engineName)).toBe(false);
  });

  test("a create that finds the shared tools volume gone is refused and leaves no volume, container or spec", async () => {
    const first = await newBox("first");
    await boxes.deleteBox(host, first.id, true);
    const tools = host.volumes.list().find((volume) => volume.role === "tools");
    if (!tools) throw new Error("the shared tools record is missing");
    runtime.volumes.delete(tools.engineName);

    expect(await rejectionOf(newBox("second"))).toMatchObject({
      status: 409,
      key: "volume_missing",
      params: { volume: tools.name },
    });
    expect(runtime.volumes.size).toBe(0);
    expect(runtime.containers.size).toBe(0);
    expect(host.specs.findByName("second")).toBeNull();
    expect(host.volumes.list().map((volume) => volume.role)).toEqual(["tools"]);
  });

  test("a legacy workspace record whose volume is gone blocks the box, instead of making a new workspace", async () => {
    runtime.volumes.set("mbtest-ws-gone", { name: "mbtest-ws-gone", labels: managed("gone") });
    await claimEngineVolumes(host);
    runtime.volumes.delete("mbtest-ws-gone");

    expect(await rejectionOf(newBox("gone"))).toMatchObject({
      status: 409,
      key: "volume_missing",
      params: { volume: "mbtest-ws-gone" },
    });
    expect(runtime.volumes.size).toBe(0);
    expect(runtime.containers.size).toBe(0);
    expect(host.volumes.list().map((volume) => volume.engineName)).toEqual(["mbtest-ws-gone"]);
  });
});

const helperSpecs = (text: string): HelperSpec[] =>
  runtime
    .callsTo("runHelper")
    .map((call) => call.args[0] as HelperSpec)
    .filter((spec) => spec.cmd.join(" ").includes(text));

describe("helper containers ask only for what their command needs", () => {
  const nasPools = [
    { name: "local", backend: "local" as const },
    {
      name: "nas",
      backend: "nfs" as const,
      server: "192.168.1.10",
      export: "/volume1/minibox",
      options: ["nfsvers=4.1", "hard"],
      default: true,
    },
  ];

  test("a new local volume is handed to the box user by a root helper that holds CHOWN alone", async () => {
    await newBox("alpha");
    const chowns = helperSpecs("chown");
    expect(chowns.length).toBeGreaterThan(0);
    for (const spec of chowns) expect(spec).toMatchObject({ user: "0:0", capAdd: ["CHOWN"] });
  });

  test("directories on an NFS pool are made with CHOWN and DAC_OVERRIDE, and removed with DAC_OVERRIDE", async () => {
    await savePools(host, nasPools, undefined);
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));
    await rejectionOf(newBox("alpha"));

    const made = helperSpecs("mkdir -p");
    expect(made.length).toBeGreaterThan(0);
    for (const spec of made) expect(spec).toMatchObject({ user: "0:0", capAdd: ["CHOWN", "DAC_OVERRIDE"] });
    const removed = helperSpecs("rmdir");
    expect(removed.length).toBeGreaterThan(0);
    for (const spec of removed) expect(spec).toMatchObject({ user: "0:0", capAdd: ["DAC_OVERRIDE"] });
  });

  test("measuring reads other owners' directories with DAC_READ_SEARCH and nothing else", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    await measureVolume(host, notes.id);
    const measured = helperSpecs("du -sb");
    expect(measured).toHaveLength(1);
    expect(measured[0]).toMatchObject({ user: "0:0", capAdd: ["DAC_READ_SEARCH"] });
  });

  test("pool probes run as the box user and hold no capability", async () => {
    await savePools(host, [...nasPools, { name: "disk", backend: "path", root: "/mnt/disk" }], undefined);
    const before = runtime.callsTo("runHelper").length;
    await getPools(host, { force: true });
    const probes = runtime
      .callsTo("runHelper")
      .slice(before)
      .map((call) => call.args[0] as HelperSpec);
    expect(probes.map((spec) => spec.cmd.join(" ")).filter((cmd) => cmd.includes("df -B1 -P"))).toHaveLength(2);
    for (const spec of probes) {
      expect(spec.user).toBe(DEV_OWNER);
      expect(spec.capAdd).toBeUndefined();
    }
  });
});
