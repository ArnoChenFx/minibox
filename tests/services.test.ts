import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

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
      restart: "unless-stopped",
      cpus: 1,
      memoryBytes: 256 * MB,
      swapBytes: 256 * MB,
      init: true,
      mounts: [{ source: "mbtest-ws-alpha", target: "/workspace" }],
    });
    expect(runtime.volumes.get("mbtest-ws-alpha")?.labels).toEqual({ [keys.box]: "true", [keys.name]: "alpha" });
    expect(runtime.ops()).toEqual([
      "listContainers",
      "inspectImage",
      "inspectVolume",
      "createVolume",
      "createContainer",
      "startContainer",
      "inspectContainer",
    ]);
  });

  test("reuses a workspace volume that already exists", async () => {
    runtime.volumes.set("mbtest-ws-alpha", { name: "mbtest-ws-alpha", labels: {} });
    await newBox("alpha");
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
  });

  test("a duplicate name is a conflict and creates nothing", async () => {
    await newBox("alpha");
    const before = runtime.calls.length;

    const error = await rejectionOf(newBox("alpha"));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, key: "box_exists", params: { name: "alpha" } });
    expect(runtime.ops().slice(before)).toEqual(["listContainers"]);
  });

  test("a missing template image is rejected before any volume is created", async () => {
    const error = await rejectionOf(newBox("alpha", { image: "ghost:latest" }));
    expect(error).toMatchObject({ status: 400, key: "template_image_missing", details: { field: "template" } });
    expect(runtime.callsTo("createVolume")).toHaveLength(0);
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
  });

  test("the template label defaults to the image and can name a snapshot instead", async () => {
    expect((await newBox("alpha")).template).toBe(host.baseTemplateTag);
    expect((await newBox("beta", { templateLabel: "snapshot:x" })).template).toBe("snapshot:x");
  });

  test("an engine conflict during create propagates as a RuntimeError", async () => {
    runtime.fail("createContainer", new RuntimeError("conflict", "name taken", "name taken"));
    expect(await rejectionOf(newBox("alpha"))).toMatchObject({ kind: "conflict" });
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

    expect(await boxes.deleteBox(host, box.id, true)).toEqual({ name: "alpha", volumeDeleted: false });
    expect(runtime.containers.size).toBe(0);
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);
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

  test("resource updates only send the limits that were given, and memory also sets swap", async () => {
    const box = await newBox("alpha");
    expect(await boxes.updateResources(host, box.id, { cpus: 2 })).toMatchObject({ cpus: 2, memory: 256 * MB });
    expect(runtime.callsTo("updateContainer")[0]?.args[1]).toEqual({ cpus: 2 });

    await boxes.updateResources(host, box.id, { memoryMb: 512 });
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
        `LABEL ${keys.snapshot}=true`,
        `LABEL ${keys.snapshotOf}=alpha`,
        `LABEL ${keys.templateName}=nightly`,
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
        `LABEL ${keys.template}=true`,
        `LABEL ${keys.snapshot}=false`,
        `LABEL ${keys.templateName}=gold`,
        `LABEL ${keys.templateDesc}="a 'quoted' description"`,
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

  test("concurrent base builds share one engine build, and a later build runs again", async () => {
    const [first, second] = await Promise.all([buildBaseTemplate(host), buildBaseTemplate(host)]);
    expect(runtime.callsTo("buildImage")).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first.ref).toBe(host.baseTemplateTag);

    await buildBaseTemplate(host);
    expect(runtime.callsTo("buildImage")).toHaveLength(2);
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

  test("build output returned to the caller is capped at its last 4000 characters", async () => {
    runtime.buildLog = `${"a".repeat(3000)}${"b".repeat(3000)}`;
    const { output } = await buildBaseTemplate(host);
    expect(output).toHaveLength(4000);
    expect(output.endsWith("b".repeat(3000))).toBe(true);
  });
});
