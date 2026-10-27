import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import {
  createDeclaredTemplate,
  declaredTemplate,
  readRecipe,
  rebuildDeclaredTemplate,
  templateSetupOf,
} from "../src/services/template-builds";
import {
  deleteTemplate,
  forkTemplate,
  listTemplates,
  saveBoxAsTemplate,
  templateSourceImage,
} from "../src/services/templates";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { DEVCONTAINER_WITH_SETUP, serveRepository } from "./support/repository";
import { call, finishedTask, type Harness, mint, type Reply, refused, startHarness } from "./support/tokens";

const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";
const DEV_SETUP = { postCreate: ["/bin/sh", "-c", "npm install"], forwardPorts: [3000] };

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
  readonly progress: string[];
}

function lab(): Lab {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  return { app, runtime, host, keys: host.keys, progress: [] };
}

const progressOf = (l: Lab) => ({ log: (text: string) => l.progress.push(text) });

/** A declared template `tool` built from a pasted Dockerfile, which is what a fork copies its recipe from. */
async function declared(l: Lab, name = "tool"): Promise<void> {
  await createDeclaredTemplate(
    l.host,
    { name, source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
    progressOf(l),
  );
}

describe("forking a template that was built from a source", () => {
  test("the new image carries the template labels of the new name, and the source keeps its own", async () => {
    const l = lab();
    await declared(l);
    const sourceId = (await l.runtime.inspectImage("mbtest-template:tool")).id;

    const forked = await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      description: "Our own toolchain",
      createdBy: "owner",
    });

    expect(forked).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
    const made = await l.runtime.inspectImage("mbtest-template:tool-copy");
    expect(made.id).not.toBe(sourceId);
    expect(made.labels).toMatchObject({
      [l.keys.template]: "true",
      [l.keys.templateName]: "tool-copy",
      [l.keys.templateDesc]: "Our own toolchain",
      [l.keys.createdBy]: "owner",
      [l.keys.snapshot]: "false",
    });
    expect(made.labels[l.keys.created]).toBeString();
    // The source is untouched: same image, same labels, same tag.
    const source = await l.runtime.inspectImage("mbtest-template:tool");
    expect(source.id).toBe(sourceId);
    expect(source.tags).toEqual(["mbtest-template:tool"]);
    expect(source.labels[l.keys.templateName]).toBe("tool");
    expect(source.labels[l.keys.templateDesc]).toBe("Built from a Dockerfile");
    expect(l.runtime.containers.size).toBe(0);
  });

  test("the recipe is copied under the new name, and its imageId is the new image", async () => {
    const l = lab();
    await declared(l);
    const sourceRecipe = readRecipe(l.host, "tool");

    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    const recipe = readRecipe(l.host, "tool-copy");
    const image = await l.runtime.inspectImage("mbtest-template:tool-copy");
    expect(recipe?.imageId).toBe(image.id);
    expect(recipe?.source).toEqual(sourceRecipe?.source);
    expect(recipe?.createdBy).toBe("owner");
    // The source's recipe still names the source's image, so neither rebuild reads the other's image.
    expect(readRecipe(l.host, "tool")?.imageId).toBe(sourceRecipe?.imageId);
    expect(readRecipe(l.host, "tool")?.imageId).not.toBe(recipe?.imageId);
  });

  test("a fork with no description copies the source's, and its recipe keeps null so a rebuild makes the default", async () => {
    const l = lab();
    await declared(l);

    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    expect((await l.runtime.inspectImage("mbtest-template:tool-copy")).labels[l.keys.templateDesc]).toBe(
      "Built from a Dockerfile",
    );
    expect(readRecipe(l.host, "tool-copy")?.description).toBeNull();
  });

  test("a devcontainer template's setup is copied, so a box created from the fork gets it too", async () => {
    const l = lab();
    serveRepository(l.runtime, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(l),
    );

    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:dev"), {
      name: "dev-copy",
      createdBy: "owner",
    });

    expect(readRecipe(l.host, "dev")?.init).toEqual(DEV_SETUP);
    expect(readRecipe(l.host, "dev-copy")?.init).toEqual(DEV_SETUP);
    expect(await templateSetupOf(l.host, "mbtest-template:dev-copy")).toEqual(DEV_SETUP);
  });

  test("a rebuild of the fork builds from the source the original was built from, into the fork's own tag", async () => {
    const l = lab();
    await declared(l);
    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });
    const beforeFork = (await l.runtime.inspectImage("mbtest-template:tool-copy")).id;
    const sourceBefore = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    const buildsBefore = l.runtime.builds.length;

    const declaredFork = await declaredTemplate(l.host, "mbtest-template:tool-copy");
    expect(declaredFork.recipe.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
    await rebuildDeclaredTemplate(l.host, declaredFork, progressOf(l));

    expect(l.runtime.builds).toHaveLength(buildsBefore + 1);
    const build = l.runtime.builds.at(-1);
    expect(build?.tag).toBe("mbtest-template:tool-copy");
    expect(build?.files.get("Dockerfile")).toBe(FROM_ALPINE);
    const afterFork = (await l.runtime.inspectImage("mbtest-template:tool-copy")).id;
    expect(afterFork).not.toBe(beforeFork);
    expect(readRecipe(l.host, "tool-copy")?.imageId).toBe(afterFork);
    // The template the fork came from is not rebuilt, and keeps the image it had.
    expect((await l.runtime.inspectImage("mbtest-template:tool")).id).toBe(sourceBefore);
    expect(readRecipe(l.host, "tool")?.imageId).toBe(sourceBefore);
  });
});

describe("forking a template that was saved from a box", () => {
  test("the fork is a working template with no build kind, and it has no recipe to rebuild from", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    await saveBoxAsTemplate(l.host, box.boxId, { name: "gold", description: "Node 26 toolchain" }, "owner");

    const forked = await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:gold"), {
      name: "gold-copy",
      createdBy: "owner",
    });

    expect(forked.ref).toBe("mbtest-template:gold-copy");
    const listed = (await listTemplates(l.host)).find((template) => template.name === "gold-copy");
    expect(listed).toMatchObject({ ref: "mbtest-template:gold-copy", description: "Node 26 toolchain" });
    expect(listed).not.toHaveProperty("buildKind");
    // A fork names no box, so it is not a save of the box the original came from.
    expect(listed?.source).toBeNull();
    expect(listed?.sourceId).toBeNull();
    expect(readRecipe(l.host, "gold-copy")).toBeNull();
    const recipeError = await rejectionOf(declaredTemplate(l.host, "mbtest-template:gold-copy"));
    expect(recipeError).toMatchObject({ status: 400, key: "template_not_declared" });
    // The original keeps naming the box it was saved from.
    const source = (await listTemplates(l.host)).find((template) => template.name === "gold");
    expect(source).toMatchObject({ source: "alpha", sourceId: box.boxId });
  });

  test("deleting the template a fork came from leaves the fork and its boxes alone", async () => {
    const l = lab();
    await declared(l);
    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });
    const forkId = (await l.runtime.inspectImage("mbtest-template:tool-copy")).id;

    await deleteTemplate(l.host, "mbtest-template:tool");

    expect(
      await l.runtime.inspectImage("mbtest-template:tool").then(
        () => "held",
        () => "gone",
      ),
    ).toBe("gone");
    expect((await l.runtime.inspectImage("mbtest-template:tool-copy")).id).toBe(forkId);
    expect(readRecipe(l.host, "tool")).toBeNull();
    expect(readRecipe(l.host, "tool-copy")?.imageId).toBe(forkId);
    const box = await boxes.createBox(l.host, {
      name: "beta",
      cpus: 1,
      memoryMb: 256,
      image: "mbtest-template:tool-copy",
    });
    expect(box.template).toBe("mbtest-template:tool-copy");
  });
});

describe("the template a fork copies", () => {
  test("is found by its name, its tag or its image id, and anything else is not found", async () => {
    const l = lab();
    await declared(l);
    const byTag = await templateSourceImage(l.host, "mbtest-template:tool");
    const byName = await templateSourceImage(l.host, "tool");
    const byId = await templateSourceImage(l.host, (await l.runtime.inspectImage("mbtest-template:tool")).id);
    expect([byName.name, byTag.name, byId.name]).toEqual(["tool", "tool", "tool"]);
    expect(await rejectionOf(templateSourceImage(l.host, "mbtest-template:nowhere"))).toMatchObject({ status: 404 });
    expect(await rejectionOf(templateSourceImage(l.host, "nowhere"))).toMatchObject({ status: 404 });
  });

  test("is not a snapshot or a plain image, so a fork never copies those", async () => {
    const l = lab();
    l.runtime.seedImage("mbtest-snap:nightly", { [l.keys.snapshot]: "true" });
    expect(await rejectionOf(templateSourceImage(l.host, "mbtest-snap:nightly"))).toMatchObject({
      status: 404,
      key: "template_not_found",
    });
  });
});

describe("a fork that fails", () => {
  test("leaves no image and no recipe, so the name stays free", async () => {
    const l = lab();
    await declared(l);
    l.runtime.fail("commitContainer", new RuntimeError("engine", "no space left on device"));

    const error = await rejectionOf(
      forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
        name: "tool-copy",
        createdBy: "owner",
      }),
    );

    expect(error).toBeInstanceOf(RuntimeError);
    expect(
      await l.runtime.inspectImage("mbtest-template:tool-copy").then(
        () => "held",
        () => "gone",
      ),
    ).toBe("gone");
    expect(readRecipe(l.host, "tool-copy")).toBeNull();
    expect(l.runtime.containers.size).toBe(0);
  });
});

function namesOf(reply: Reply): (string | null)[] {
  return (reply.json.templates ?? []).map((template) => template.name);
}

const forkPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/fork`;

describe("template.fork over REST and tokens", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = startHarness();
  });

  afterEach(() => harness.stop());

  async function declaredOverRest(name: string): Promise<void> {
    const started = await call(harness.base, "/api/templates", {
      body: { name, source: { kind: "dockerfile", text: FROM_ALPINE } },
    });
    expect(started.status).toBe(202);
    expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");
  }

  test("answers 201 with the new template, which lists with its own name and description", async () => {
    await declaredOverRest("tool");

    const made = await call(harness.base, forkPath("mbtest-template:tool"), {
      body: { name: "tool-copy", description: "Our own toolchain" },
    });

    expect(made.status).toBe(201);
    expect(made.json.template).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
    const listed = await call(harness.base, "/api/templates");
    expect(listed.json.templates).toContainEqual(
      expect.objectContaining({
        ref: "mbtest-template:tool-copy",
        name: "tool-copy",
        description: "Our own toolchain",
        buildKind: "dockerfile",
      }),
    );
  });

  test("a bare template name names the template too", async () => {
    await declaredOverRest("tool");

    const made = await call(harness.base, forkPath("tool"), { body: { name: "tool-copy" } });

    expect(made.status).toBe(201);
    expect(made.json.template).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
  });

  test("a name already taken is refused as a conflict, and no image is committed", async () => {
    await declaredOverRest("tool");
    await declaredOverRest("tool-copy");
    const since = harness.runtime.calls.length;

    const again = await call(harness.base, forkPath("mbtest-template:tool"), { body: { name: "tool-copy" } });

    expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
    expect(harness.runtime.calls.slice(since).map((entry) => entry.op)).not.toContain("commitContainer");
  });

  test("a template that does not exist is not found", async () => {
    const missing = await call(harness.base, forkPath("mbtest-template:nowhere"), { body: { name: "copy" } });
    expect(refused(missing)).toEqual({ status: 404, key: "template_not_found" });
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
  });

  test("a fork of a saved template works and cannot be rebuilt, as the template it came from could not", async () => {
    const box = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    const saved = await call(harness.base, `/api/boxes/${box.json.box?.boxId ?? ""}/template`, {
      body: { name: "gold" },
    });
    expect((await finishedTask(harness.base, saved.json.taskId ?? "")).status).toBe("succeeded");

    const made = await call(harness.base, forkPath("mbtest-template:gold"), { body: { name: "gold-copy" } });

    expect(made.status).toBe(201);
    const rebuild = await call(
      harness.base,
      `/api/templates/${encodeURIComponent("mbtest-template:gold-copy")}/rebuild`,
      {
        body: {},
      },
    );
    expect(refused(rebuild)).toEqual({ status: 400, key: "template_not_declared" });
  });

  test("deleting the source after a fork leaves the fork, and the fork's own recipe, in place", async () => {
    await declaredOverRest("tool");
    expect((await call(harness.base, forkPath("mbtest-template:tool"), { body: { name: "tool-copy" } })).status).toBe(
      201,
    );

    const removed = await call(harness.base, `/api/templates/${encodeURIComponent("mbtest-template:tool")}`, {
      method: "DELETE",
    });

    expect(removed.status).toBe(200);
    expect(namesOf(await call(harness.base, "/api/templates"))).toEqual(["tool-copy", "base"]);
  });

  test("a token may fork a template it can see into a free name, and may not fork another principal's template", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    // The owner builds one, which every token may use, and one token saves its own box as a second.
    await declaredOverRest("shared");
    const box = await call(harness.base, "/api/boxes", {
      token: maker.secret,
      body: { name: "maker-box", cpus: 1, memoryMb: 256 },
    });
    const saved = await call(harness.base, `/api/boxes/${box.json.box?.boxId ?? ""}/template`, {
      token: maker.secret,
      body: { name: "makers" },
    });
    expect((await finishedTask(harness.base, saved.json.taskId ?? "")).status).toBe("succeeded");

    const mine = await call(harness.base, forkPath("mbtest-template:shared"), {
      token: maker.secret,
      body: { name: "shared-copy" },
    });
    expect(mine.status).toBe(201);
    expect(harness.runtime.callsTo("commitContainer").at(-1)?.args[1]).toMatchObject({ tag: "shared-copy" });
    const made = await harness.runtime.inspectImage("mbtest-template:shared-copy");
    expect(made.labels[harness.app.hosts.get().keys.createdBy]).toBe(maker.id);

    const stolen = await call(harness.base, forkPath("mbtest-template:makers"), {
      token: other.secret,
      body: { name: "stolen" },
    });
    expect(refused(stolen)).toEqual({ status: 403, key: "template_out_of_scope" });
  });

  test("a token may not fork into a name another principal holds", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    await declaredOverRest("shared");
    expect(
      (await call(harness.base, forkPath("mbtest-template:shared"), { token: maker.secret, body: { name: "mine" } }))
        .status,
    ).toBe(201);

    const clash = await call(harness.base, forkPath("mbtest-template:shared"), {
      token: other.secret,
      body: { name: "mine" },
    });

    expect(refused(clash)).toEqual({ status: 403, key: "template_out_of_scope" });
  });

  test("a sandboxed agent may not fork a template", async () => {
    const sandboxed = mint(harness.app, { name: "sandboxed", preset: "sandboxed-agent" });
    await declaredOverRest("tool");
    const reply = await call(harness.base, forkPath("mbtest-template:tool"), {
      token: sandboxed.secret,
      body: { name: "tool-copy" },
    });
    expect(refused(reply)).toEqual({ status: 403, key: "operation_forbidden" });
  });
});
