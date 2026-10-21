import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { rebuildBox } from "../src/services/rebuild";
import type { BoxMount } from "../src/specs/types";
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
const workspace = (name: string): BoxMount => ({ volume: `mbtest-ws-${name}`, path: "/workspace", mode: "rw" });

function specOf(boxId: string) {
  const spec = host.specs.read(boxId);
  if (!spec) throw new Error(`expected a spec for ${boxId}`);
  return spec;
}

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
    const beta = await newBox("beta");
    await boxes.updateBox(host, beta.boxId, beta.revision, { name: "gamma" });
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
      { profile: "strict", mounts: [workspace("alpha")] },
      true,
    );
    expect(fixed.mounts).toEqual([workspace("alpha")]);
  });
});

describe("other volumes", () => {
  test("a volume without the MiniBox label is refused before a preview is offered", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("pgdata", { name: "pgdata", labels: {} });
    const creates = runtime.callsTo("createContainer").length;
    const mounts: BoxMount[] = [workspace("alpha"), { volume: "pgdata", path: "/data", mode: "rw" }];

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { mounts }, false));
    expect(error).toMatchObject({ status: 403, key: "volume_unmanaged", params: { volume: "pgdata" } });
    expect(runtime.callsTo("containerDiff")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.volumes.get("pgdata")?.labels).toEqual({});
  });

  test("a volume that another box mounts is refused", async () => {
    await newBox("alpha");
    const beta = await newBox("beta");
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(
      rebuildBox(
        host,
        beta.boxId,
        beta.revision,
        { mounts: [{ volume: "mbtest-ws-alpha", path: "/shared", mode: "ro" }] },
        true,
      ),
    );
    expect(error).toMatchObject({ status: 403, key: "volume_in_use", params: { volume: "mbtest-ws-alpha" } });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(specOf(beta.boxId).mounts).toEqual([workspace("beta")]);
  });

  test("a labelled volume that no box mounts can be attached", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("archive", { name: "archive", labels: managedLabels("old") });

    const rebuilt = await rebuildBox(
      host,
      box.id,
      box.revision,
      { mounts: [workspace("alpha"), { volume: "archive", path: "/archive", mode: "ro" }] },
      true,
    );
    expect(rebuilt.mounts).toEqual([workspace("alpha"), { volume: "archive", path: "/archive", mode: "ro" }]);
    expect(runtime.containers.get(rebuilt.id)?.spec.mounts).toContainEqual({
      source: "archive",
      target: "/archive",
      mode: "ro",
    });
  });

  test("a new volume named in a rebuild is created with the MiniBox label", async () => {
    const box = await newBox("alpha");
    await rebuildBox(
      host,
      box.id,
      box.revision,
      { mounts: [workspace("alpha"), { volume: "scratch", path: "/scratch", mode: "rw" }] },
      true,
    );
    expect(runtime.volumes.get("scratch")?.labels).toEqual(managedLabels("alpha"));
  });

  test("a volume the box already mounts is kept without a label check", async () => {
    const box = await newBox("alpha");
    runtime.volumes.set("pgdata", { name: "pgdata", labels: {} });
    const spec = specOf(box.boxId);
    host.specs.write({ ...spec, mounts: [...spec.mounts, { volume: "pgdata", path: "/data", mode: "rw" }] });

    const rebuilt = await rebuildBox(host, box.id, box.revision, { profile: "strict" }, true);
    expect(rebuilt.mounts).toContainEqual({ volume: "pgdata", path: "/data", mode: "rw" });
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
