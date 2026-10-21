import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { STANDARD_CAPS } from "../src/box-profile";
import type { AuditNote } from "../src/events/types";
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
      volume: "mbtest-ws-alpha",
    });
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
      mounts: [{ source: "mbtest-ws-alpha", target: "/workspace" }],
    });
    expect(runtime.volumes.get("mbtest-ws-alpha")?.labels).toEqual({ [keys.box]: "true", [keys.name]: "alpha" });
    expect(runtime.ops()).toEqual([
      "inspectImage",
      "ensureBridgeNetwork",
      "inspectVolume",
      "createVolume",
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
    await newBox("alpha");
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
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
    expect(runtime.volumes.size).toBe(0);
  });

  test("keeps the workspace volume unless asked to delete it", async () => {
    const box = await newBox("alpha");
    expect(await boxes.deleteBox(host, box.id, false)).toEqual({ name: "alpha", volumeDeleted: false });
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);
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
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);
  });

  test("a volume still mounted elsewhere is kept and the engine's reason is returned", async () => {
    const box = await newBox("alpha");
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "other",
      mounts: [{ source: "mbtest-ws-alpha", target: "/data" }],
    });

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({
      name: "alpha",
      volumeDeleted: false,
      volumeError: "remove mbtest-ws-alpha: volume is in use",
    });
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);
  });

  test("a volume that is already gone counts as deleted", async () => {
    const box = await newBox("alpha");
    runtime.volumes.delete("mbtest-ws-alpha");

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({ name: "alpha", volumeDeleted: true });
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

describe("workspace root owner on create", () => {
  const DEV_LABELS = { "minibox.template.uid": "1000", "minibox.template.gid": "1000" };
  const ROOT = { uid: 0, gid: 0 };
  const DEV = { uid: 1000, gid: 1000 };
  const WORKSPACE = "mbtest-ws-alpha";

  /** A workspace volume that an earlier box left behind, with its root owned by root. */
  async function rootOwnedVolume(): Promise<void> {
    await runtime.createVolume(WORKSPACE, { [keys.box]: "true", [keys.name]: "alpha" });
    runtime.seedVolumeOwner(WORKSPACE, ROOT);
  }

  test("a reused workspace root owned by root is set to the template's owner before the box starts", async () => {
    const imageId = runtime.seedImage("dev:1", DEV_LABELS);
    await rootOwnedVolume();

    const box = await newBox("alpha", { image: "dev:1" });

    expect(runtime.callsTo("setVolumeRootOwner").map((call) => call.args)).toEqual([[WORKSPACE, DEV, imageId]]);
    const ops = runtime.ops();
    expect(ops.indexOf("setVolumeRootOwner")).toBeGreaterThan(ops.indexOf("createContainer"));
    expect(ops.indexOf("setVolumeRootOwner")).toBeLessThan(ops.indexOf("startContainer"));
    expect(await runtime.volumeRootOwner(box.id, "/workspace")).toEqual(DEV);
  });

  test("a fresh workspace volume already has the template's owner, so create only reads it", async () => {
    runtime.seedImage("dev:1", DEV_LABELS);

    await newBox("alpha", { image: "dev:1" });

    expect(runtime.callsTo("volumeRootOwner")).toHaveLength(1);
    expect(runtime.callsTo("setVolumeRootOwner")).toHaveLength(0);
  });

  test("a root that cannot be set stops the create: the container is removed and no box is written or started", async () => {
    runtime.seedImage("dev:1", DEV_LABELS);
    await rootOwnedVolume();
    runtime.fail("setVolumeRootOwner", new RuntimeError("engine", "chown failed", "chown failed"));

    expect(await rejectionOf(newBox("alpha", { image: "dev:1" }))).toMatchObject({ kind: "engine" });
    expect(runtime.containers.size).toBe(0);
    expect(runtime.callsTo("startContainer")).toHaveLength(0);
    expect(host.specs.findByName("alpha")).toBeNull();
    expect(runtime.volumeOwners.get(WORKSPACE)).toEqual(ROOT);
  });

  test("a changed root is recorded as an audit note of the create", async () => {
    runtime.seedImage("dev:1", DEV_LABELS);
    await rootOwnedVolume();
    const notes: AuditNote[] = [];

    await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256, image: "dev:1" }, (note) => notes.push(note));

    expect(notes).toEqual([
      {
        op: "volume.chown",
        kind: "write",
        status: "ok",
        summary: `Volume owner set: ${WORKSPACE}`,
        target: { kind: "volume", name: WORKSPACE },
        detail: { from: "0:0", to: "1000:1000" },
      },
    ]);
  });

  test("a template that names no owner reads and changes no workspace root", async () => {
    await newBox("alpha");

    expect(runtime.callsTo("volumeRootOwner")).toHaveLength(0);
    expect(runtime.callsTo("setVolumeRootOwner")).toHaveLength(0);
  });
});
