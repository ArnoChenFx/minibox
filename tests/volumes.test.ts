import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";

import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { ExecutorHooks } from "../src/operations/executor";
import type { OperationContext } from "../src/operations/types";
import type { HelperSpec } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { reconcileHost } from "../src/services/reconcile";
import { attachVolume, createVolume, getPools, listVolumes, savePools } from "../src/services/volumes";
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
