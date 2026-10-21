import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { STANDARD_CAPS } from "../src/box-profile";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { AppError } from "../src/lib/errors";
import { type BuildSpec, RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { listImagesByLabel } from "../src/services/images";
import { createSnapshot, deleteSnapshot, listSnapshots } from "../src/services/snapshots";
import { buildBaseTemplate, deleteTemplate, listTemplates, promoteSnapshot } from "../src/services/templates";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let runtime: FakeRuntime;
let host: HostCtx;
let keys: LabelKeys;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  runtime = created.runtime;
  host = created.app.hosts.get();
  keys = host.keys;
  runtime.seedImage(host.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
});

const newBox = (name: string, extra: Partial<Parameters<typeof boxes.createBox>[1]> = {}) =>
  boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...extra });

describe("createBox", () => {
  test("creates a labelled container and volume, mounts the workspace and starts the box", async () => {
    const box = await newBox("alpha");

    expect(box).toMatchObject({
      name: "alpha",
      running: true,
      cpus: 1,
      memory: 256 * MB,
      template: host.baseTemplateTag,
    });
    expect(box.volume).toMatch(/^vol_/);
    const container = runtime.containers.get(box.id);
    expect(container?.spec).toMatchObject({
      name: "mbtest-alpha",
      image: host.baseTemplateTag,
      cmd: ["sleep", "infinity"],
      workingDir: "/workspace",
      hostname: "alpha",
      restart: "no",
      cpus: 1,
      memoryBytes: 256 * MB,
      swapBytes: 256 * MB,
      init: true,
    });
    expect(container?.spec.mounts?.map((mount) => ({ target: mount.target, mode: mount.mode }))).toEqual([
      { target: "/workspace", mode: "rw" },
      { target: "/home/dev", mode: "rw" },
      { target: "/opt/minibox/tools", mode: "ro" },
      { target: "/home/dev/.cache", mode: "rw" },
    ]);
    expect(runtime.volumes.get(box.volume)?.labels).toMatchObject({
      [keys.box]: "true",
      [keys.volume]: "true",
      [keys.name]: "alpha-workspace",
      [keys.role]: "workspace",
      [keys.pool]: "local",
    });
    expect(runtime.ops()).toEqual([
      "inspectImage",
      "ensureBridgeNetwork",
      "inspectVolume",
      "inspectVolume",
      "info",
      "diskUsage",
      "createVolume",
      "inspectVolume",
      "createVolume",
      "inspectVolume",
      "createVolume",
      "inspectVolume",
      "createVolume",
      "runHelper",
      "inspectVolume",
      "inspectVolume",
      "inspectVolume",
      "inspectVolume",
      "createContainer",
      "startContainer",
      "inspectContainer",
    ]);
  });

  test("reuses a labelled workspace volume that an earlier box left behind", async () => {
    runtime.volumes.set("mbtest-ws-alpha", {
      name: "mbtest-ws-alpha",
      labels: { [keys.box]: "true", [keys.name]: "alpha" },
    });
    const box = await newBox("alpha");
    expect(box.volume).toBe("mbtest-ws-alpha");
    expect(runtime.callsTo("createVolume").map((call) => call.args[0])).not.toContain("mbtest-ws-alpha");
  });

  test("a duplicate name is a conflict and creates nothing", async () => {
    await newBox("alpha");
    const before = runtime.calls.length;

    const error = await rejectionOf(newBox("alpha"));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, key: "box_exists", params: { name: "alpha" } });
    expect(runtime.ops().slice(before)).toEqual([]);
    expect(runtime.containers.size).toBe(1);
  });

  test("a missing template image is rejected before any volume or network is created", async () => {
    const error = await rejectionOf(newBox("alpha", { image: "ghost:latest" }));
    expect(error).toMatchObject({ status: 400, key: "template_image_missing", details: { field: "template" } });
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
    expect(runtime.callsTo("ensureBridgeNetwork")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
  });

  test("the template label defaults to the image and can name a snapshot instead", async () => {
    expect((await newBox("alpha")).template).toBe(host.baseTemplateTag);
    expect((await newBox("beta", { templateLabel: "snapshot:x" })).template).toBe("snapshot:x");
  });

  test("a name claimed by a concurrent create is a duplicate, not an engine error", async () => {
    runtime.fail("createContainer", new RuntimeError("conflict", "name taken", "name taken"));
    expect(await rejectionOf(newBox("alpha"))).toMatchObject({ status: 409, key: "box_exists" });
    expect(runtime.callsTo("startContainer")).toHaveLength(0);
  });

  test("an engine outage while checking the template is not reported as a missing template", async () => {
    runtime.fail("inspectImage", new RuntimeError("unavailable", "connect ECONNREFUSED", "connect ECONNREFUSED"));
    expect(await rejectionOf(newBox("alpha"))).toMatchObject({ kind: "unavailable" });
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
  });

  test("a failed volume lookup stops the create instead of creating a volume blindly", async () => {
    runtime.fail("inspectVolume", new RuntimeError("engine", "volume lookup failed", "volume lookup failed"));
    expect(await rejectionOf(newBox("alpha"))).toMatchObject({ kind: "engine" });
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
  });
});

describe("box security profiles", () => {
  const ULIMITS = [
    { name: "core", soft: 0, hard: 0 },
    { name: "nofile", soft: 65536, hard: 65536 },
  ];

  test("a new box gets the host's default profile, its hardening and the box network", async () => {
    const box = await newBox("alpha");
    expect(box).toMatchObject({ profile: "standard", network: "mbtest-boxes" });

    const container = runtime.containers.get(box.id);
    expect(container?.labels).toMatchObject({ [keys.profile]: "standard" });
    expect(container?.spec).toMatchObject({
      network: "mbtest-boxes",
      hardening: { capDrop: ["ALL"], capAdd: [...STANDARD_CAPS], pidsLimit: 1024, ulimits: ULIMITS },
    });
    expect(container?.spec.hardening?.noNewPrivileges).toBeUndefined();
  });

  test("the profile chosen for a box decides its hardening", async () => {
    const strict = await newBox("strict-box", { profile: "strict" });
    expect(strict.profile).toBe("strict");
    expect(runtime.containers.get(strict.id)?.spec.hardening).toEqual({
      capDrop: ["ALL"],
      noNewPrivileges: true,
      pidsLimit: 1024,
      ulimits: ULIMITS,
    });

    const relaxed = await newBox("relaxed-box", { profile: "relaxed" });
    expect(relaxed.profile).toBe("relaxed");
    expect(runtime.containers.get(relaxed.id)?.spec.hardening).toEqual({ pidsLimit: 1024, ulimits: ULIMITS });
  });

  test("the host's process limit and runtime apply to the boxes it creates", async () => {
    const other = createTestApp({
      labelPrefix: "mbtest",
      boxProfile: "strict",
      boxPidsLimit: 256,
      containerRuntime: "runsc",
    });
    const otherHost = other.app.hosts.get();
    other.runtime.seedImage(otherHost.baseTemplateTag, { [otherHost.keys.template]: "true" });

    const box = await boxes.createBox(otherHost, { name: "gamma", cpus: 1, memoryMb: 256 });
    expect(box.profile).toBe("strict");
    expect(other.runtime.containers.get(box.id)?.spec.hardening).toMatchObject({
      noNewPrivileges: true,
      pidsLimit: 256,
      runtime: "runsc",
    });
  });

  test("the box network is ensured with inter-container communication off before a box is created", async () => {
    await newBox("alpha");
    expect(runtime.callsTo("ensureBridgeNetwork").map((c) => c.args)).toEqual([
      ["mbtest-boxes", { interContainerComm: false }],
    ]);
    expect(runtime.networks.get("mbtest-boxes")?.options).toEqual({
      "com.docker.network.bridge.enable_icc": "false",
    });
  });

  test("a network that lets boxes reach each other blocks creation with a 409 and creates nothing", async () => {
    runtime.seedNetwork("mbtest-boxes", {});

    const error = await rejectionOf(newBox("alpha"));
    expect(error).toMatchObject({ status: 409, key: "box_network_conflict", params: { network: "mbtest-boxes" } });
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
  });

  test("a stopped box starts after its pruned network is re-created, once it is attached to the new one", async () => {
    const box = await newBox("alpha");
    await boxes.stopBox(host, box.id);
    runtime.pruneNetworks();
    expect(runtime.networks.has("mbtest-boxes")).toBe(false);

    expect(await boxes.startBox(host, box.id)).toMatchObject({ running: true });
    expect(runtime.networks.has("mbtest-boxes")).toBe(true);
    expect(runtime.callsTo("reattachNetwork")[0]?.args).toEqual([box.id, "mbtest-boxes"]);
  });

  test("restart attaches a stopped box to the re-created network the same way", async () => {
    const box = await newBox("alpha");
    await boxes.stopBox(host, box.id);
    runtime.pruneNetworks();

    expect(await boxes.restartBox(host, box.id)).toMatchObject({ running: true });
    expect(runtime.networks.has("mbtest-boxes")).toBe(true);
    expect(runtime.callsTo("reattachNetwork")).toHaveLength(1);
  });

  test("a stopped box is attached to its network before the engine starts it", async () => {
    const box = await newBox("alpha");
    await boxes.stopBox(host, box.id);
    const before = runtime.calls.length;

    await boxes.startBox(host, box.id);
    const ops = runtime.ops().slice(before);
    expect(ops.indexOf("reattachNetwork")).toBeGreaterThan(-1);
    expect(ops.indexOf("reattachNetwork")).toBeLessThan(ops.indexOf("startContainer"));
  });

  test("a running box keeps its network endpoint when it is started or restarted", async () => {
    const box = await newBox("alpha");
    await boxes.startBox(host, box.id);
    await boxes.restartBox(host, box.id);

    expect(runtime.callsTo("reattachNetwork")).toHaveLength(0);
  });

  test("boxes created before profiles keep the default bridge, have no profile and are not touched", async () => {
    const id = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-legacy",
      labels: { [keys.box]: "true", [keys.name]: "legacy" },
    });
    expect(await boxes.getBox(host, id)).toMatchObject({ profile: null, network: "bridge" });

    await boxes.stopBox(host, id);
    expect(await boxes.startBox(host, id)).toMatchObject({ running: true, profile: null, network: "bridge" });
    expect(runtime.callsTo("ensureBridgeNetwork")).toHaveLength(0);
    expect(runtime.callsTo("reattachNetwork")).toHaveLength(0);
    expect(runtime.containers.get(id)?.spec.hardening).toBeUndefined();
  });
});

describe("deleteBox", () => {
  test("removes the container before its volume so the volume is no longer in use", async () => {
    const box = await newBox("alpha");

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({ name: "alpha", volumeDeleted: true });
    const ops = runtime.ops();
    expect(ops.indexOf("removeContainer")).toBeLessThan(ops.indexOf("removeVolume"));
    expect(runtime.containers.size).toBe(0);
    const left = [...runtime.volumes.values()].filter((volume) => volume.labels[keys.role] === "tools");
    expect(left).toHaveLength(1);
    expect(runtime.volumes.has(box.volume)).toBe(false);
  });

  test("keeps the workspace volume unless asked to delete it", async () => {
    const box = await newBox("alpha");
    expect(await boxes.deleteBox(host, box.id, false)).toEqual({ name: "alpha", volumeDeleted: false });
    expect(runtime.volumes.has(box.volume)).toBe(true);
  });

  test("a failed volume removal is reported without failing the request", async () => {
    const box = await newBox("alpha");
    runtime.fail("removeVolume", new RuntimeError("engine", "device busy", "device busy"));

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({
      name: "alpha",
      volumeDeleted: false,
      volumeError: "device busy",
    });
    expect(runtime.containers.size).toBe(0);
    expect(runtime.volumes.has(box.volume)).toBe(true);
  });

  test("a volume still mounted elsewhere is kept and the engine's reason is returned", async () => {
    const box = await newBox("alpha");
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "other",
      mounts: [{ source: box.volume, target: "/data" }],
    });

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({
      name: "alpha",
      volumeDeleted: false,
      volumeError: `remove ${box.volume}: volume is in use`,
    });
    expect(runtime.volumes.has(box.volume)).toBe(true);
  });

  test("a volume that is already gone counts as deleted", async () => {
    const box = await newBox("alpha");
    runtime.volumes.delete(box.volume);

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({ name: "alpha", volumeDeleted: true });
  });

  test("a workspace with no record is never removed, even when its volume is asked for", async () => {
    const box = await newBox("alpha");
    const workspace = host.volumes.findByEngine(host.host.id, box.volume);
    if (!workspace) throw new Error("the workspace has no record");
    host.volumes.remove(workspace.id);

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({ name: "alpha", volumeDeleted: true });
    expect(runtime.callsTo("removeVolume").map((call) => call.args[0])).not.toContain(box.volume);
    expect(runtime.volumes.has(box.volume)).toBe(true);
  });

  test("a volume another box owns is kept, even when the box being deleted still mounts it", async () => {
    const alpha = await newBox("alpha");
    const beta = await newBox("beta");
    const alphaSpec = host.specs.read(alpha.boxId);
    const betaSpec = host.specs.read(beta.boxId);
    if (!alphaSpec || !betaSpec) throw new Error("both boxes need a spec");
    const workspace = alphaSpec.mounts.find((mount) => mount.path === "/workspace");
    if (!workspace) throw new Error("alpha has no workspace mount");
    host.specs.write({ ...alphaSpec, mounts: alphaSpec.mounts.filter((mount) => mount.path !== "/workspace") });
    host.specs.write({ ...betaSpec, mounts: [...betaSpec.mounts, workspace] });

    expect(await boxes.deleteBox(host, beta.id, true)).toEqual({ name: "beta", volumeDeleted: true });
    expect(runtime.callsTo("removeVolume").map((call) => call.args[0])).not.toContain(alpha.volume);
    expect(runtime.volumes.has(alpha.volume)).toBe(true);
    expect(host.volumes.findByEngine(host.host.id, alpha.volume)).toMatchObject({
      ownership: "owned",
      ownerBoxId: alpha.boxId,
    });
  });

  test("an owned record with no owner is never removed", async () => {
    const box = await newBox("alpha");
    const workspace = host.volumes.findByEngine(host.host.id, box.volume);
    if (!workspace) throw new Error("the workspace has no record");
    host.volumes.write({ ...workspace, ownerBoxId: null });

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({ name: "alpha", volumeDeleted: true });
    expect(runtime.volumes.has(box.volume)).toBe(true);
    expect(host.volumes.read(workspace.id)).toMatchObject({ ownership: "owned", ownerBoxId: null });
  });

  test("containers without the MiniBox label are never removed", async () => {
    const id = runtime.seedContainer({ image: host.baseTemplateTag, name: "plain" });
    expect(await rejectionOf(boxes.deleteBox(host, id, true))).toMatchObject({
      status: 404,
      key: "box_not_found",
    });
    expect(runtime.callsTo("removeContainer")).toHaveLength(0);
  });
});

describe("box lifecycle and resources", () => {
  test("stop and restart give the engine a 3 second timeout", async () => {
    const box = await newBox("alpha");
    await boxes.stopBox(host, box.id);
    await boxes.restartBox(host, box.id);

    expect(runtime.callsTo("stopContainer")[0]?.args[1]).toEqual({ timeoutSec: 3 });
    expect(runtime.callsTo("restartContainer")[0]?.args[1]).toEqual({ timeoutSec: 3 });
  });

  test("stop and restart use the configured STOP_TIMEOUT_SEC", async () => {
    const custom = createTestApp({ labelPrefix: "mbtest", stopTimeoutSec: 12 });
    const customHost = custom.app.hosts.get();
    custom.runtime.seedImage(customHost.baseTemplateTag, { [customHost.keys.template]: "true" });
    const box = await boxes.createBox(customHost, { name: "alpha", cpus: 1, memoryMb: 256 });

    await boxes.stopBox(customHost, box.id);
    await boxes.restartBox(customHost, box.id);
    expect(custom.runtime.callsTo("stopContainer")[0]?.args[1]).toEqual({ timeoutSec: 12 });
    expect(custom.runtime.callsTo("restartContainer")[0]?.args[1]).toEqual({ timeoutSec: 12 });
  });

  test("resource updates only send the limits that were given, and memory also sets swap", async () => {
    const box = await newBox("alpha");
    const resized = await boxes.updateResources(host, box.id, { cpus: 2 }, box.revision);
    expect(resized).toMatchObject({ cpus: 2, memory: 256 * MB });
    expect(runtime.callsTo("updateContainer")[0]?.args[1]).toEqual({ cpus: 2 });

    await boxes.updateResources(host, box.id, { memoryMb: 512 }, resized.revision);
    expect(runtime.callsTo("updateContainer")[1]?.args[1]).toEqual({ memoryBytes: 512 * MB, swapBytes: 512 * MB });
  });

  test("logs are read with timestamps and the requested tail", async () => {
    const box = await newBox("alpha");
    const container = runtime.containers.get(box.id);
    if (!container) throw new Error("box missing");
    container.logs = "a\nb\nc\n";

    expect(await boxes.getLogs(host, box.id, 2)).toBe("b\nc\n");
    expect(runtime.callsTo("containerLogs")[0]?.args[1]).toEqual({ tail: 2, timestamps: true });
  });

  test("stats exist only for running boxes", async () => {
    const box = await newBox("alpha");
    expect(await boxes.getStats(host, box.id)).toMatchObject({ memLimit: 256 * MB });
    await boxes.stopBox(host, box.id);
    expect(await boxes.getStats(host, box.id)).toBeNull();
  });

  test("boxes are listed by name and only when labelled", async () => {
    await newBox("zulu");
    await newBox("alpha");
    runtime.seedContainer({ image: host.baseTemplateTag, name: "plain" });
    expect((await boxes.listBoxes(host)).map((b) => b.name)).toEqual(["alpha", "zulu"]);
  });
});

describe("snapshots", () => {
  test("createSnapshot commits a paused box with snapshot labels and the sleep command", async () => {
    const box = await newBox("alpha");
    const { ref, source } = await createSnapshot(host, box.id, "nightly");

    expect(source).toBe("alpha");
    expect(ref).toMatch(/^mbtest-snap:nightly-\d{8}-\d{6}$/);
    expect(runtime.callsTo("commitContainer")[0]?.args[1]).toMatchObject({
      repo: "mbtest-snap",
      pause: true,
      author: "minibox",
      changes: expect.arrayContaining([
        `LABEL ${keys.snapshot}="true"`,
        `LABEL ${keys.snapshotOf}="alpha"`,
        `LABEL ${keys.templateName}="nightly"`,
        'CMD ["sleep","infinity"]',
      ]),
    });
    expect(await listSnapshots(host)).toEqual([expect.objectContaining({ ref, source: "alpha", name: "nightly" })]);
  });

  test("deleteSnapshot only removes images that carry the snapshot label", async () => {
    runtime.seedImage("alpine:3.20");
    expect(await rejectionOf(deleteSnapshot(host, "alpine:3.20"))).toMatchObject({
      status: 404,
      key: "snapshot_not_found",
    });
    expect(runtime.callsTo("removeImage")).toHaveLength(0);

    const box = await newBox("alpha");
    const { ref } = await createSnapshot(host, box.id, "spare");
    await deleteSnapshot(host, ref);
    expect(await listSnapshots(host)).toEqual([]);
  });

  test("an engine outage while deleting a snapshot is not reported as a missing snapshot", async () => {
    const box = await newBox("alpha");
    const { ref } = await createSnapshot(host, box.id, "spare");
    runtime.fail("inspectImage", new RuntimeError("unavailable", "connect ECONNREFUSED", "connect ECONNREFUSED"));

    expect(await rejectionOf(deleteSnapshot(host, ref))).toMatchObject({ kind: "unavailable" });
    expect(runtime.callsTo("removeImage")).toHaveLength(0);
  });

  test("snapshot lists are newest first", async () => {
    runtime.seedImage("mbtest-snap:old", { [keys.snapshot]: "true" }, "2026-10-01T00:00:00.000Z");
    runtime.seedImage("mbtest-snap:new", { [keys.snapshot]: "true" }, "2026-10-02T00:00:00.000Z");
    expect((await listImagesByLabel(host, keys.snapshot)).map((i) => i.ref)).toEqual([
      "mbtest-snap:new",
      "mbtest-snap:old",
    ]);
  });
});

describe("templates", () => {
  test("promoteSnapshot re-tags a snapshot as a template through a scratch container that is always removed", async () => {
    const box = await newBox("alpha");
    const { ref } = await createSnapshot(host, box.id, "source");

    const promoted = await promoteSnapshot(host, ref, "gold", `a "quoted" description`);
    expect(promoted).toEqual({ ref: "mbtest-template:gold", name: "gold" });

    expect(runtime.callsTo("createContainer").at(-1)?.args[0]).toEqual({ image: ref, cmd: ["true"] });
    expect(runtime.callsTo("commitContainer").at(-1)?.args[1]).toMatchObject({
      repo: "mbtest-template",
      tag: "gold",
      changes: expect.arrayContaining([
        `LABEL ${keys.template}="true"`,
        `LABEL ${keys.snapshot}="false"`,
        `LABEL ${keys.templateName}="gold"`,
        `LABEL ${keys.templateDesc}="a \\"quoted\\" description"`,
      ]),
    });
    expect(runtime.containers.size).toBe(1);
    expect((await listTemplates(host)).map((t) => t.ref)).toContain("mbtest-template:gold");
  });

  test("a failed commit still removes the scratch container and reports the engine error", async () => {
    const box = await newBox("alpha");
    const { ref } = await createSnapshot(host, box.id, "source");
    runtime.fail("commitContainer", new RuntimeError("engine", "commit failed", "commit failed"));

    expect(await rejectionOf(promoteSnapshot(host, ref, "broken"))).toMatchObject({ kind: "engine" });
    const scratch = runtime.callsTo("createContainer").at(-1);
    const scratchId = runtime.callsTo("commitContainer").at(-1)?.args[0];
    expect(scratch).toBeDefined();
    expect(runtime.callsTo("removeContainer").at(-1)?.args).toEqual([scratchId, { force: true }]);
    expect(runtime.containers.size).toBe(1);
  });

  test("promoting an image that is not a snapshot is refused", async () => {
    runtime.seedImage("plain:1");
    expect(await rejectionOf(promoteSnapshot(host, "plain:1", "x"))).toMatchObject({ status: 404 });
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
  });

  test("an engine outage while looking up a snapshot is not reported as a missing snapshot", async () => {
    const box = await newBox("alpha");
    const { ref } = await createSnapshot(host, box.id, "source");
    runtime.fail("inspectImage", new RuntimeError("unavailable", "connect ECONNREFUSED", "connect ECONNREFUSED"));

    expect(await rejectionOf(promoteSnapshot(host, ref, "gold"))).toMatchObject({ kind: "unavailable" });
    expect(runtime.callsTo("createContainer")).toHaveLength(1);
  });

  test("deleteTemplate removes template images and refuses other images", async () => {
    const template = runtime.seedImage("mbtest-template:tmp", { [keys.template]: "true" });
    await deleteTemplate(host, "mbtest-template:tmp");
    expect(runtime.images.has(template)).toBe(false);

    runtime.seedImage("plain:1");
    expect(await rejectionOf(deleteTemplate(host, "plain:1"))).toMatchObject({
      status: 404,
      key: "template_not_found",
    });
  });

  test("an engine outage while deleting a template is not reported as a missing template", async () => {
    runtime.seedImage("mbtest-template:tmp", { [keys.template]: "true" });
    runtime.fail("inspectImage", new RuntimeError("unavailable", "connect ECONNREFUSED", "connect ECONNREFUSED"));

    expect(await rejectionOf(deleteTemplate(host, "mbtest-template:tmp"))).toMatchObject({ kind: "unavailable" });
    expect(runtime.callsTo("removeImage")).toHaveLength(0);
  });

  test("each base build calls the engine, and the log is reported as it is produced", async () => {
    runtime.buildLog = "line\n";
    const lines: string[] = [];
    const first = await buildBaseTemplate(host, { log: (text) => lines.push(text) });
    expect(first).toEqual({ ref: host.baseTemplateTag, output: "line\n" });
    expect(lines).toEqual(["line\n"]);
    expect(runtime.callsTo("buildImage")).toHaveLength(1);
  });

  test("aborting a build rejects once the engine call returns, and no image is kept", async () => {
    const held = runtime.hold("buildImage");
    const images = runtime.images.size;
    const controller = new AbortController();
    const pending = buildBaseTemplate(host, { signal: controller.signal, log: () => {} });
    controller.abort();
    held.release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.callsTo("buildImage")).toHaveLength(1);
    expect(runtime.images.size).toBe(images);
  });

  test("the build spec points at the bundled base template with its labels", async () => {
    await buildBaseTemplate(host);
    const [call] = runtime.callsTo("buildImage");
    const spec = call?.args[0] as BuildSpec;
    expect(spec).toMatchObject({
      dockerfile: "Dockerfile",
      tag: host.baseTemplateTag,
      labels: { [keys.template]: "true", [keys.templateName]: "base" },
    });
    expect(spec.contextDir).toMatch(/templates\/base$/);
  });
});
