import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { rebuildBox } from "../src/services/rebuild";
import { createVolume } from "../src/services/volumes";
import type { BoxMount } from "../src/specs/types";
import { claimEngineVolumes } from "../src/volumes/engine";
import type { TerminalData } from "../src/ws/terminal";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let runtime: FakeRuntime;
let app: App;
let host: HostCtx;
let keys: LabelKeys;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  app = created.app;
  runtime = created.runtime;
  host = app.hosts.get();
  keys = host.keys;
  runtime.seedImage(host.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
});

const newBox = (name: string) => boxes.createBox(host, { name, cpus: 1, memoryMb: 256 });
const managedLabels = (name: string) => ({ [keys.box]: "true", [keys.name]: name });
const plainMounts = (mounts: BoxMount[]): BoxMount[] =>
  mounts.map(({ volume, path, mode }) => ({ volume, path, mode }));

/** The box's own workspace mount, as the engine names it. New boxes get `vol_…` engine names. */
function workspaceOf(boxId: string): BoxMount {
  const mount = specOf(boxId).mounts.find((item) => item.path === "/workspace");
  if (!mount) throw new Error(`expected a workspace for ${boxId}`);
  return mount;
}

function specOf(boxId: string) {
  const spec = host.specs.read(boxId);
  if (!spec) throw new Error(`expected a spec for ${boxId}`);
  return spec;
}

/** Rebuilds `box` with its workspace and one more mount, confirmed. */
const attach = (box: { id: string; revision: number; boxId: string }, mount: BoxMount) =>
  rebuildBox(host, box.id, box.revision, { mounts: [workspaceOf(box.boxId), mount] }, true);

/** Puts a box in the state of one created before the box network: it runs on the engine's default bridge. */
function moveToBridge(boxId: string, containerId: string): void {
  host.specs.write({ ...specOf(boxId), network: "bridge" });
  const container = runtime.containers.get(containerId);
  if (!container) throw new Error(`expected a container ${containerId}`);
  container.spec = { ...container.spec, network: "bridge" };
}

describe("creating a box", () => {
  test("a workspace volume without the MiniBox label is refused and nothing is created", async () => {
    runtime.volumes.set("mbtest-ws-alpha", { name: "mbtest-ws-alpha", labels: {} });
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(newBox("alpha"));
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      key: "volume_unmanaged",
      params: { volume: "mbtest-ws-alpha" },
    });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(host.specs.findByName("alpha")).toBeNull();
    expect(runtime.volumes.get("mbtest-ws-alpha")?.labels).toEqual({});
  });

  test("a workspace volume that another box still mounts is refused", async () => {
    runtime.volumes.set("mbtest-ws-beta", { name: "mbtest-ws-beta", labels: managedLabels("beta") });
    await claimEngineVolumes(host);
    await boxes.createBox(host, {
      name: "gamma",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: "mbtest-ws-beta", path: "/workspace", mode: "rw" }],
    });
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(newBox("beta"));
    expect(error).toMatchObject({ status: 403, key: "volume_in_use", params: { volume: "mbtest-ws-beta" } });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(host.specs.findByName("beta")).toBeNull();
  });
});

describe("the data volume", () => {
  test("is refused whether it is unlabelled, labelled or absent, and the box keeps its container", async () => {
    const box = await newBox("alpha");
    const creates = runtime.callsTo("createContainer").length;
    const dataMount: BoxMount[] = [{ volume: "minibox-data", path: "/data", mode: "ro" }];

    runtime.volumes.set("minibox-data", { name: "minibox-data", labels: {} });
    const unlabelled = await rejectionOf(rebuildBox(host, box.id, box.revision, { mounts: dataMount }, true));
    expect(unlabelled).toMatchObject({ status: 403, key: "volume_reserved", params: { volume: "minibox-data" } });

    runtime.volumes.set("minibox-data", { name: "minibox-data", labels: managedLabels("alpha") });
    const labelled = await rejectionOf(rebuildBox(host, box.id, box.revision, { mounts: dataMount }, true));
    expect(labelled).toMatchObject({ status: 403, key: "volume_reserved" });

    runtime.volumes.delete("minibox-data");
    const absent = await rejectionOf(rebuildBox(host, box.id, box.revision, { mounts: dataMount }, true));
    expect(absent).toMatchObject({ status: 403, key: "volume_reserved" });

    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("a box that already mounts it cannot be rebuilt until it drops the mount", async () => {
    const box = await newBox("alpha");
    const spec = specOf(box.boxId);
    host.specs.write({ ...spec, mounts: [...spec.mounts, { volume: "minibox-data", path: "/data", mode: "ro" }] });

    const refused = await rejectionOf(rebuildBox(host, box.id, box.revision, { profile: "strict" }, true));
    expect(refused).toMatchObject({ status: 403, key: "volume_reserved" });
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");

    const fixed = await rebuildBox(
      host,
      box.id,
      box.revision,
      { profile: "strict", mounts: [workspaceOf(box.boxId)] },
      true,
    );
    expect(plainMounts(fixed.mounts)).toEqual([workspaceOf(box.boxId)]);
  });
});

describe("other volumes", () => {
  test("a volume without the MiniBox label is refused before a preview is offered", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("pgdata", { name: "pgdata", labels: {} });
    const creates = runtime.callsTo("createContainer").length;
    const mounts: BoxMount[] = [workspaceOf(box.boxId), { volume: "pgdata", path: "/data", mode: "rw" }];

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { mounts }, false));
    expect(error).toMatchObject({ status: 403, key: "volume_unmanaged", params: { volume: "pgdata" } });
    expect(runtime.callsTo("containerDiff")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.volumes.get("pgdata")?.labels).toEqual({});
  });

  test("a volume that another box owns is refused", async () => {
    const alpha = await newBox("alpha");
    const beta = await newBox("beta");
    const creates = runtime.callsTo("createContainer").length;
    const before = specOf(beta.boxId).mounts;

    const error = await rejectionOf(
      rebuildBox(
        host,
        beta.boxId,
        beta.revision,
        { mounts: [{ volume: alpha.volume, path: "/shared", mode: "ro" }] },
        true,
      ),
    );
    expect(error).toMatchObject({ status: 403, key: "volume_in_use", params: { volume: "alpha-workspace" } });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(specOf(beta.boxId).mounts).toEqual(before);
  });

  test("a labelled volume that no box mounts can be attached", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("archive", { name: "archive", labels: managedLabels("old") });

    const rebuilt = await rebuildBox(
      host,
      box.id,
      box.revision,
      { mounts: [workspaceOf(box.boxId), { volume: "archive", path: "/archive", mode: "ro" }] },
      true,
    );
    expect(plainMounts(rebuilt.mounts)).toEqual([
      workspaceOf(box.boxId),
      { volume: "archive", path: "/archive", mode: "ro" },
    ]);
    expect(runtime.containers.get(rebuilt.id)?.spec.mounts).toContainEqual({
      source: "archive",
      target: "/archive",
      mode: "ro",
    });
  });

  test("a new volume named in a rebuild becomes a standalone record with a MiniBox engine volume", async () => {
    const box = await newBox("alpha");
    const rebuilt = await rebuildBox(
      host,
      box.id,
      box.revision,
      { mounts: [workspaceOf(box.boxId), { volume: "scratch", path: "/scratch", mode: "rw" }] },
      true,
    );
    const record = host.volumes.resolve("scratch", host.host.id);
    if (!record) throw new Error("expected a record for scratch");
    expect(record).toMatchObject({ name: "scratch", ownership: "independent", ownerBoxId: null, role: null });
    expect(record.engineName).toMatch(/^vol_/);
    expect(runtime.volumes.has("scratch")).toBe(false);
    expect(runtime.volumes.get(record.engineName)?.labels).toMatchObject({
      [keys.volume]: "true",
      [keys.box]: "true",
      [keys.name]: "scratch",
    });
    expect(runtime.containers.get(rebuilt.id)?.spec.mounts).toContainEqual({
      source: record.engineName,
      target: "/scratch",
      mode: "rw",
    });
  });

  test("a volume the box already mounts is kept without a label check", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("pgdata", { name: "pgdata", labels: {} });
    const spec = specOf(box.boxId);
    host.specs.write({ ...spec, mounts: [...spec.mounts, { volume: "pgdata", path: "/data", mode: "rw" }] });

    const rebuilt = await rebuildBox(host, box.id, box.revision, { profile: "strict" }, true);
    expect(plainMounts(rebuilt.mounts)).toContainEqual({ volume: "pgdata", path: "/data", mode: "rw" });
  });
});

describe("networks", () => {
  test("host, none and container networks are refused, and the box keeps its network", async () => {
    const box = await newBox("alpha");
    const creates = runtime.callsTo("createContainer").length;

    for (const network of ["host", "none", "container:abc123"]) {
      const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { network }, true));
      expect(error).toMatchObject({ status: 403, key: "network_reserved", params: { network } });
    }
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(specOf(box.boxId).network).toBe("mbtest-boxes");
  });

  test("another network is refused even when it exists, and so is bridge for a box on the box network", async () => {
    const box = await newBox("alpha");
    runtime.seedNetwork("corp-net", {});

    const corp = await rejectionOf(rebuildBox(host, box.id, box.revision, { network: "corp-net" }, true));
    expect(corp).toMatchObject({
      status: 403,
      key: "network_not_managed",
      params: { network: "corp-net", managed: "mbtest-boxes" },
    });

    const bridge = await rejectionOf(rebuildBox(host, box.id, box.revision, { network: "bridge" }, false));
    expect(bridge).toMatchObject({ status: 403, key: "network_not_managed", params: { network: "bridge" } });
    expect(specOf(box.boxId).network).toBe("mbtest-boxes");
  });

  test("a box created before the box network keeps bridge while other fields change", async () => {
    const box = await newBox("alpha");
    moveToBridge(box.boxId, box.id);

    const rebuilt = await rebuildBox(host, box.id, box.revision, { env: [{ name: "FOO", value: "bar" }] }, true);
    expect(rebuilt.network).toBe("bridge");
    expect(rebuilt.env).toEqual([{ name: "FOO", value: "bar" }]);
  });

  test("a box created before the box network moves onto it when asked", async () => {
    const box = await newBox("alpha");
    moveToBridge(box.boxId, box.id);

    const rebuilt = await rebuildBox(host, box.id, box.revision, { network: "mbtest-boxes" }, true);
    expect(rebuilt.network).toBe("mbtest-boxes");
    expect(specOf(rebuilt.boxId).network).toBe("mbtest-boxes");
  });

  test("a box that already runs on host networking is refused until it leaves it", async () => {
    const box = await newBox("alpha");
    host.specs.write({ ...specOf(box.boxId), network: "host" });

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { profile: "strict" }, true));
    expect(error).toMatchObject({ status: 403, key: "network_reserved", params: { network: "host" } });
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
  });
});

describe("record-based rules", () => {
  test("a standalone record may be mounted by several boxes", async () => {
    await createVolume(host, { name: "shared", role: null, createdBy: "owner" });
    const alpha = await newBox("alpha");
    const beta = await newBox("beta");
    await attach(alpha, { volume: "shared", path: "/shared", mode: "ro" });

    const second = await attach(beta, { volume: "shared", path: "/shared", mode: "ro" });
    expect(second.mounts.map((mount) => mount.volumeName)).toContain("shared");
  });

  test("a recorded volume the engine no longer has is refused and is not recreated", async () => {
    const gone = await createVolume(host, { name: "gone", role: null, createdBy: "owner" });
    runtime.volumes.delete(gone.engineName);
    const box = await newBox("alpha");
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(attach(box, { volume: "gone", path: "/gone", mode: "rw" }));
    expect(error).toMatchObject({ status: 409, key: "volume_missing", params: { volume: "gone" } });
    expect(runtime.volumes.has(gone.engineName)).toBe(false);
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("a volume the box already mounts is refused once the engine has lost it, instead of being recreated", async () => {
    const box = await newBox("alpha");
    runtime.volumes.delete(box.volume);

    const error = await rejectionOf(
      rebuildBox(host, box.id, box.revision, { env: [{ name: "FOO", value: "bar" }] }, true),
    );
    expect(error).toMatchObject({ status: 409, key: "volume_missing", params: { volume: "alpha-workspace" } });
    expect(runtime.volumes.has(box.volume)).toBe(false);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("pool roots are refused whether or not they exist, and internal helper volumes are refused", async () => {
    const box = await newBox("alpha");
    const creates = runtime.callsTo("createContainer").length;
    const onto = (volume: string) => attach(box, { volume, path: "/pool", mode: "rw" });

    const absent = await rejectionOf(onto("mbtest-pool-nfs"));
    expect(absent).toMatchObject({ status: 403, key: "volume_reserved", params: { volume: "mbtest-pool-nfs" } });

    runtime.volumes.set("mbtest-pool-nfs", {
      name: "mbtest-pool-nfs",
      labels: { [keys.volume]: "true", [keys.internal]: "true", [keys.pool]: "nfs" },
    });
    const present = await rejectionOf(onto("mbtest-pool-nfs"));
    expect(present).toMatchObject({ status: 403, key: "volume_reserved" });

    runtime.volumes.set("helper-cache", { name: "helper-cache", labels: { [keys.internal]: "true" } });
    const internal = await rejectionOf(onto("helper-cache"));
    expect(internal).toMatchObject({ status: 403, key: "volume_reserved", params: { volume: "helper-cache" } });

    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(host.volumes.resolve("mbtest-pool-nfs", host.host.id)).toBeNull();
  });

  test("a workspace-prefixed name that does not exist yet is refused and nothing is created", async () => {
    const box = await newBox("alpha");
    const error = await rejectionOf(attach(box, { volume: "mbtest-ws-fresh", path: "/fresh", mode: "rw" }));
    expect(error).toMatchObject({ status: 403, key: "volume_reserved", params: { volume: "mbtest-ws-fresh" } });
    expect(runtime.volumes.has("mbtest-ws-fresh")).toBe(false);
    expect(host.volumes.resolve("mbtest-ws-fresh", host.host.id)).toBeNull();
  });

  test("an id that matches no volume is not created under that name", async () => {
    const box = await newBox("alpha");
    const error = await rejectionOf(attach(box, { volume: "vol_nothere00", path: "/x", mode: "ro" }));
    expect(error).toMatchObject({ status: 404, key: "volume_not_found" });
    expect(runtime.volumes.has("vol_nothere00")).toBe(false);
  });

  test("a failed container create removes the volume the rebuild created", async () => {
    const box = await newBox("alpha");
    const volumesBefore = [...runtime.volumes.keys()].toSorted();
    runtime.fail("createContainer", new RuntimeError("engine", "boom", "boom"));

    const error = await rejectionOf(attach(box, { volume: "ephemeral", path: "/ephemeral", mode: "rw" }));
    expect(error).toMatchObject({ kind: "engine" });
    expect(host.volumes.resolve("ephemeral", host.host.id)).toBeNull();
    expect([...runtime.volumes.keys()].toSorted()).toEqual(volumesBefore);
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
  });

  test("a labelled volume that no box mounts is recorded when it is attached", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("archive", { name: "archive", labels: managedLabels("old") });

    await attach(box, { volume: "archive", path: "/archive", mode: "ro" });
    expect(host.volumes.resolve("archive", host.host.id)).toMatchObject({
      name: "archive",
      engineName: "archive",
      ownership: "independent",
    });
  });
});

describe("refusals over HTTP", () => {
  test("a refused mount is a 403 with a key the UI can translate", async () => {
    const box = await newBox("alpha");
    const server: Server<TerminalData> = startServer(app);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/boxes/${box.id}/rebuild`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_KEY}`,
          "content-type": "application/json",
          "if-match": String(box.revision),
        },
        body: JSON.stringify({ mounts: [{ volume: "minibox-data", path: "/data", mode: "ro" }], confirm: true }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string; key: string; params: unknown } };
      expect(body.error).toMatchObject({
        code: "forbidden",
        key: "volume_reserved",
        params: { volume: "minibox-data" },
      });
    } finally {
      server.stop(true);
    }
  });
});
