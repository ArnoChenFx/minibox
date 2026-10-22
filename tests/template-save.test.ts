import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import type { CommitSpec } from "../src/runtime";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { listTemplates, promoteSnapshot, saveBoxAsTemplate } from "../src/services/templates";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { call, finishedTask, type Harness, mint, type Reply, refused, startHarness } from "./support/tokens";

/** Calls that read or write the content of a volume. A save touches none of them. */
const VOLUME_CALLS: string[] = [
  "createVolume",
  "removeVolume",
  "putArchive",
  "getArchive",
  "statPath",
  "runHelper",
  "setVolumeRootOwner",
];

let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => restoreLogs());

interface Lab {
  readonly app: App;
  readonly runtime: FakeRuntime;
  readonly host: HostCtx;
  readonly keys: LabelKeys;
}

function lab(): Lab {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  return { app, runtime, host, keys: host.keys };
}

/** The `commitContainer` call at `index` of the recorded calls. The last one by default. */
function commitAt(runtime: FakeRuntime, index = -1): CommitSpec {
  const entry = runtime.callsTo("commitContainer").at(index);
  if (!entry) throw new Error("no commit was made");
  return entry.args[1] as CommitSpec;
}

describe("saving a box as a template", () => {
  test("commits the box, promotes the commit under the name, and removes the intermediate snapshot", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });

    const saved = await saveBoxAsTemplate(
      l.host,
      box.boxId,
      { name: "gold", description: "Node 26 toolchain" },
      "owner",
    );

    expect(saved).toEqual({ ref: "mbtest-template:gold", name: "gold" });
    expect((await l.runtime.inspectImage("mbtest-template:gold")).labels).toMatchObject({
      [l.keys.template]: "true",
      [l.keys.snapshot]: "false",
      [l.keys.templateName]: "gold",
      [l.keys.templateDesc]: "Node 26 toolchain",
      [l.keys.createdBy]: "owner",
      [l.keys.snapshotOf]: "alpha",
      [l.keys.snapshotOfId]: box.boxId,
    });
    expect(await l.runtime.listImages({ labels: { [l.keys.snapshot]: "true" } })).toEqual([]);
  });

  test("the box is committed paused, and no volume is read or written", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    const since = l.runtime.calls.length;

    await saveBoxAsTemplate(l.host, box.boxId, { name: "gold" }, "owner");

    expect(l.runtime.calls.slice(since).filter((entry) => VOLUME_CALLS.includes(entry.op))).toEqual([]);
    expect(commitAt(l.runtime, 0).pause).toBe(true);
  });

  test("the template names the box it came from, and the default description says so", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });

    await saveBoxAsTemplate(l.host, box.boxId, { name: "plain" }, "owner");

    const listed = (await listTemplates(l.host)).find((template) => template.name === "plain");
    expect(listed).toMatchObject({
      ref: "mbtest-template:plain",
      description: "Saved from box alpha",
      source: "alpha",
      sourceId: box.boxId,
      createdBy: "owner",
    });
  });

  test("a failed promotion removes the intermediate snapshot and leaves no template", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    const progress = {
      log: (text: string) => {
        if (text.startsWith("Saving ")) {
          l.runtime.fail("commitContainer", new RuntimeError("unavailable", "engine went away"));
        }
      },
    };

    const error = await rejectionOf(saveBoxAsTemplate(l.host, box.boxId, { name: "gold" }, "owner", progress));

    expect(error).toBeInstanceOf(RuntimeError);
    expect(await l.runtime.listImages({ labels: { [l.keys.snapshot]: "true" } })).toEqual([]);
    const templates = await l.runtime.listImages({ labels: { [l.keys.template]: "true" } });
    expect(templates.flatMap((image) => image.repoTags)).not.toContain("mbtest-template:gold");
    expect(l.runtime.containers.size).toBe(1);
  });

  test("a failed removal of the intermediate snapshot does not fail the save", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    l.runtime.fail("removeImage", new RuntimeError("unavailable", "engine went away"));

    const saved = await saveBoxAsTemplate(l.host, box.boxId, { name: "gold" }, "owner");

    expect(saved.ref).toBe("mbtest-template:gold");
    expect((await l.runtime.inspectImage("mbtest-template:gold")).labels[l.keys.template]).toBe("true");
    expect(await l.runtime.listImages({ labels: { [l.keys.snapshot]: "true" } })).toHaveLength(1);
  });
});

describe("a template name that is taken", () => {
  test("saving a box under it is refused before any commit", async () => {
    const l = lab();
    l.runtime.seedImage("mbtest-template:gold", { [l.keys.template]: "true", [l.keys.templateName]: "gold" });
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    const since = l.runtime.calls.length;

    const error = await rejectionOf(saveBoxAsTemplate(l.host, box.boxId, { name: "gold" }, "owner"));

    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      key: "template_name_taken",
      params: { name: "gold" },
    });
    expect(l.runtime.calls.slice(since).map((entry) => entry.op)).not.toContain("commitContainer");
  });

  test("promoting a snapshot under it is refused, and the existing template keeps its image", async () => {
    const l = lab();
    l.runtime.seedImage("mbtest-snap:nightly", { [l.keys.snapshot]: "true" });
    const existing = l.runtime.seedImage("mbtest-template:gold", {
      [l.keys.template]: "true",
      [l.keys.templateName]: "gold",
    });

    const error = await rejectionOf(promoteSnapshot(l.host, "mbtest-snap:nightly", "gold"));

    expect(error).toMatchObject({ status: 409, key: "template_name_taken" });
    expect(l.runtime.callsTo("commitContainer")).toHaveLength(0);
    expect((await l.runtime.inspectImage("mbtest-template:gold")).id).toBe(existing);
  });
});

function namesOf(reply: Reply): (string | null)[] {
  return (reply.json.templates ?? []).map((template) => template.name);
}

describe("template.save over REST and tokens", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = startHarness();
  });

  afterEach(() => harness.stop());

  async function makeBox(token: string | undefined, name: string): Promise<string> {
    const made = await call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256 } });
    expect(made.status).toBe(201);
    return made.json.box?.boxId ?? "";
  }

  function save(boxId: string, body: unknown, token?: string): Promise<Reply> {
    return call(harness.base, `/api/boxes/${boxId}/template`, { token, body });
  }

  test("answers 202 with a task that ends with the template, which lists the box it came from", async () => {
    const boxId = await makeBox(undefined, "alpha");

    const started = await save(boxId, { name: "gold", description: "tools" });

    expect(started.status).toBe(202);
    expect(await finishedTask(harness.base, started.json.taskId ?? "")).toMatchObject({
      status: "succeeded",
      result: { template: { ref: "mbtest-template:gold", name: "gold" } },
    });
    const listed = await call(harness.base, "/api/templates");
    expect(listed.json.templates).toContainEqual(
      expect.objectContaining({ ref: "mbtest-template:gold", source: "alpha" }),
    );
  });

  test("a name already taken is refused as a conflict, and no task starts", async () => {
    const boxId = await makeBox(undefined, "alpha");
    const first = await save(boxId, { name: "gold" });
    await finishedTask(harness.base, first.json.taskId ?? "");
    const before = (await call(harness.base, "/api/tasks")).json.tasks?.length;

    const again = await save(boxId, { name: "gold" });

    expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
    expect((await call(harness.base, "/api/tasks")).json.tasks?.length).toBe(before);
  });

  test("a second save of the same box while one runs is refused as busy, and names the running task", async () => {
    const boxId = await makeBox(undefined, "alpha");
    const held = harness.runtime.hold("commitContainer");
    try {
      const first = await save(boxId, { name: "one" });
      expect(first.status).toBe(202);

      const busy = await save(boxId, { name: "two" });

      expect(busy.status).toBe(409);
      expect(busy.json.error).toMatchObject({ key: "task_busy", details: { taskId: first.json.taskId } });
    } finally {
      held.release();
      await harness.app.tasks.drain();
    }
  });

  test("promoting a snapshot under a taken name is refused with the same conflict", async () => {
    const boxId = await makeBox(undefined, "alpha");
    const taken = await call(harness.base, `/api/boxes/${boxId}/snapshots`, { body: { name: "nightly" } });
    const ref = (await finishedTask(harness.base, taken.json.taskId ?? "")).result?.snapshot?.ref ?? "";
    expect(ref).not.toBe("");
    const promotePath = `/api/snapshots/${encodeURIComponent(ref)}/promote`;
    expect((await call(harness.base, promotePath, { body: { name: "gold" } })).status).toBe(201);

    const again = await call(harness.base, promotePath, { body: { name: "gold" } });

    expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
  });

  test("a template a token saves is visible to that token and the owner, and not to another token", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    const boxId = await makeBox(maker.secret, "maker-box");

    const started = await save(boxId, { name: "mine" }, maker.secret);

    expect(started.status).toBe(202);
    expect(await finishedTask(harness.base, started.json.taskId ?? "")).toMatchObject({ status: "succeeded" });
    const made = await harness.runtime.inspectImage("mbtest-template:mine");
    expect(made.labels[harness.app.hosts.get().keys.createdBy]).toBe(maker.id);
    expect(namesOf(await call(harness.base, "/api/templates", { token: maker.secret }))).toContain("mine");
    expect(namesOf(await call(harness.base, "/api/templates"))).toContain("mine");
    expect(namesOf(await call(harness.base, "/api/templates", { token: other.secret }))).not.toContain("mine");
  });

  test("a name another token's template holds is refused as out of scope, before anything runs", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    const makerBox = await makeBox(maker.secret, "maker-box");
    const first = await save(makerBox, { name: "mine" }, maker.secret);
    await finishedTask(harness.base, first.json.taskId ?? "");
    const otherBox = await makeBox(other.secret, "other-box");
    const since = harness.runtime.calls.length;

    const reply = await save(otherBox, { name: "mine" }, other.secret);

    expect(refused(reply)).toEqual({ status: 403, key: "template_out_of_scope" });
    expect(harness.runtime.calls.slice(since).map((entry) => entry.op)).not.toContain("commitContainer");
  });

  test("a box outside the token's grant is refused, and nothing is committed", async () => {
    const stranger = mint(harness.app, { name: "stranger", preset: "operator" });
    const ownersBox = await makeBox(undefined, "owners");
    const since = harness.runtime.calls.length;

    const reply = await save(ownersBox, { name: "stolen" }, stranger.secret);

    expect(refused(reply)).toEqual({ status: 403, key: "box_out_of_scope" });
    expect(harness.runtime.calls.slice(since).map((entry) => entry.op)).not.toContain("commitContainer");
  });

  test("a sandboxed agent may not save a template, and may not promote one either", async () => {
    const sandboxed = mint(harness.app, { name: "sandboxed", preset: "sandboxed-agent" });
    const boxId = await makeBox(sandboxed.secret, "sandboxed-box");
    const keys = harness.app.hosts.get().keys;
    harness.runtime.seedImage("mbtest-snap:own", {
      [keys.snapshot]: "true",
      [keys.snapshotOfId]: boxId,
      [keys.createdBy]: sandboxed.id,
    });

    expect(refused(await save(boxId, { name: "nope" }, sandboxed.secret))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    const promoted = await call(harness.base, "/api/snapshots/mbtest-snap%3Aown/promote", {
      token: sandboxed.secret,
      body: { name: "nope" },
    });
    expect(refused(promoted)).toEqual({ status: 403, key: "operation_forbidden" });
  });
});
