import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { log } from "../src/lib/logger";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import {
  createDeclaredTemplate,
  declaredTemplate,
  editRecipe,
  forkRecipe,
  readRecipe,
  rebuildDeclaredTemplate,
  templateSetupOf,
} from "../src/services/template-builds";
import {
  deleteTemplate,
  editTemplate,
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
const FROM_ALPINE_21 = "FROM alpine:3.21\nRUN true\n";
const DEV_SETUP = { postCreate: ["/bin/sh", "-c", "npm install"], forwardPorts: [3000] };
/** The Dockerfile the official `node` template ships with, read from the repository rather than from the service. */
const SHIPPED_NODE = readFileSync(
  resolve(import.meta.dir, "..", "templates", "official", "node", "Dockerfile"),
  "utf8",
);

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

/** The recipe file of a template, which a test reads to see what was written rather than what a read makes of it. */
const recipePathOf = (host: HostCtx, name: string) =>
  join(dirname(host.specs.dir()), "template-recipes", host.host.id, `${name}.json`);

function recipeOnDisk(l: Lab, name: string): { source: unknown } {
  return JSON.parse(readFileSync(recipePathOf(l.host, name), "utf8"));
}

/** The official `node` template, built from the Dockerfile that ships, as `template.official.build` builds it. */
async function officialNode(l: Lab): Promise<void> {
  await createDeclaredTemplate(
    l.host,
    { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
    progressOf(l),
  );
}

/** A fork of the official `node` template on `l`, as the console's fork action makes one. */
async function forkNode(l: Lab, name = "node-copy"): Promise<{ ref: string; name: string }> {
  return forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:node"), {
    name,
    createdBy: "owner",
  });
}

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

  test("a fork with no description copies the source's into both the image and the recipe", async () => {
    const l = lab();
    await declared(l);

    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    expect((await l.runtime.inspectImage("mbtest-template:tool-copy")).labels[l.keys.templateDesc]).toBe(
      "Built from a Dockerfile",
    );
    expect(readRecipe(l.host, "tool-copy")?.description).toBe("Built from a Dockerfile");
  });

  test("a fork uses its resolved image even when the source tag moves before its container is created", async () => {
    const l = lab();
    await declared(l);
    const source = await templateSourceImage(l.host, "mbtest-template:tool");
    l.runtime.moveTag(source.ref, { [l.keys.template]: "true", [l.keys.templateName]: "tool", marker: "replacement" });
    await forkTemplate(l.host, source, { name: "copy", createdBy: "owner" });
    const image = await l.runtime.inspectImage("mbtest-template:copy");
    expect(image.labels.marker).toBeUndefined();
    expect(l.runtime.callsTo("createContainer").at(-1)?.args[0]).toMatchObject({ image: source.image.id });
    expect(readRecipe(l.host, "copy")?.source).toEqual(source.recipe?.source);
  });

  test("a source rebuilt while the fork commits cannot replace the recipe the fork captured", async () => {
    const l = lab();
    await declared(l);
    const source = await templateSourceImage(l.host, "mbtest-template:tool");
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const commit = l.runtime.commitContainer.bind(l.runtime);
    l.runtime.commitContainer = async (id, spec) => {
      entered.resolve();
      await gate.promise;
      return commit(id, spec);
    };
    const pending = forkTemplate(l.host, source, { name: "copy", createdBy: "owner" });
    try {
      await entered.promise;
      await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, source.ref), progressOf(l));
    } finally {
      gate.resolve();
    }
    await pending;
    expect(readRecipe(l.host, "tool")?.imageId).not.toBe(source.image.id);
    expect(readRecipe(l.host, "copy")?.source).toEqual(source.recipe?.source);
    expect((await listTemplates(l.host)).find((image) => image.name === "copy")?.buildKind).toBe("dockerfile");
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

describe("forking an official template", () => {
  test("the fork is a custom template whose source is a copy of the Dockerfile that ships", async () => {
    const l = lab();
    await officialNode(l);
    // An official template may carry a setup of its own, and a fork brings it along.
    editRecipe(l.host, await declaredTemplate(l.host, "mbtest-template:node"), { init: DEV_SETUP });

    await forkNode(l);

    // Both the record on disk and what a read makes of it name the copy, so the fork can be rebuilt without the original.
    expect(recipeOnDisk(l, "node-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
    expect(readRecipe(l.host, "node-copy")?.source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
    expect(readRecipe(l.host, "node-copy")?.init).toEqual(DEV_SETUP);
    expect((await listTemplates(l.host)).find((template) => template.name === "node-copy")?.buildKind).toBe(
      "dockerfile",
    );
    // The template it came from is untouched and still official, with the source it had.
    expect(readRecipe(l.host, "node")?.source).toEqual({ kind: "official", name: "node" });
    expect((await listTemplates(l.host)).find((template) => template.name === "node")?.buildKind).toBe("official");
  });

  test("its source can be replaced, and a rebuild builds the replacement into the fork's own tag", async () => {
    const l = lab();
    await officialNode(l);
    await forkNode(l);
    const source = await declaredTemplate(l.host, "mbtest-template:node-copy");
    const image = await l.runtime.inspectImage("mbtest-template:node-copy");

    const edited = await editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } });

    expect(edited).toEqual({ ref: "mbtest-template:node-copy", name: "node-copy", buildKind: "dockerfile" });
    expect(readRecipe(l.host, "node-copy")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });

    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:node-copy"), progressOf(l));

    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-copy");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE_21);
  });

  test("the official template's own source stays fixed, so only a fork can be pointed elsewhere", async () => {
    const l = lab();
    await officialNode(l);
    const source = await declaredTemplate(l.host, "mbtest-template:node");
    const image = await l.runtime.inspectImage("mbtest-template:node");

    const error = await rejectionOf(
      editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } }),
    );

    expect(error).toMatchObject({ status: 400, key: "template_source_builtin" });
    expect(readRecipe(l.host, "node")?.source).toEqual({ kind: "official", name: "node" });
    // Its rebuild still builds the Dockerfile this MiniBox ships, not one a fork wrote.
    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:node"), progressOf(l));
    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_NODE);
  });

  test("a fork written before it kept a copy reads as built from that copy, and its next write stores it", async () => {
    const l = lab();
    await officialNode(l);
    await forkNode(l);
    // The record an earlier version wrote: the fork's own image id, under the official template's source.
    const legacy = JSON.parse(readFileSync(recipePathOf(l.host, "node-copy"), "utf8"));
    writeFileSync(
      recipePathOf(l.host, "node-copy"),
      JSON.stringify({ ...legacy, source: { kind: "official", name: "node" } }),
    );

    expect(readRecipe(l.host, "node-copy")?.source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
    expect((await listTemplates(l.host)).find((template) => template.name === "node-copy")?.buildKind).toBe(
      "dockerfile",
    );

    const source = await declaredTemplate(l.host, "mbtest-template:node-copy");
    await editTemplate(l.host, source, await l.runtime.inspectImage("mbtest-template:node-copy"), {
      init: { forwardPorts: [8080] },
    });

    // The edit did not name a source, so the one the read makes of it is what the record now keeps.
    expect(recipeOnDisk(l, "node-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
    expect(readRecipe(l.host, "node-copy")?.init).toEqual({ forwardPorts: [8080] });
  });

  test("a legacy fork's rebuild builds the copy of the Dockerfile that ships", async () => {
    const l = lab();
    await officialNode(l);
    await forkNode(l);
    const legacy = JSON.parse(readFileSync(recipePathOf(l.host, "node-copy"), "utf8"));
    writeFileSync(
      recipePathOf(l.host, "node-copy"),
      JSON.stringify({ ...legacy, source: { kind: "official", name: "node" } }),
    );

    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:node-copy"), progressOf(l));

    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-copy");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_NODE);
    // The rebuild writes back what it read, so the record now holds the copy instead of the old official source.
    expect(recipeOnDisk(l, "node-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
  });

  test("forkRecipe writes the fork's own copy even when it is handed the official source", async () => {
    const l = lab();
    await officialNode(l);
    const recipe = readRecipe(l.host, "node");
    if (!recipe) throw new Error("the official template has a recipe");
    const imageId = l.runtime.seedImage("mbtest-template:node-copy", { [l.keys.template]: "true" });

    forkRecipe(l.host, "node-copy", recipe, imageId, "Forked", "owner");

    expect(recipeOnDisk(l, "node-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
    expect(readRecipe(l.host, "node-copy")?.imageId).toBe(imageId);
  });

  test("a Dockerfile that cannot become the copy keeps the official source, warns, and keeps the fork", async () => {
    // A MiniBox whose shipped Dockerfile is not a Dockerfile: the copy cannot be made from it.
    const dir = mkdtempSync(join(tmpdir(), "minibox-templates-"));
    mkdirSync(join(dir, "official", "node"), { recursive: true });
    writeFileSync(join(dir, "official", "node", "Dockerfile"), "RUN true\n");
    const { app, runtime } = createTestApp({ templatesDir: dir });
    const host = app.hosts.get();
    const l: Lab = { app, runtime, host, keys: host.keys, progress: [] };
    const warnings = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await officialNode(l);
      await forkNode(l);

      expect(readRecipe(l.host, "node-copy")?.source).toEqual({ kind: "official", name: "node" });
      const kept = warnings.mock.calls.filter(([event]) => event === "template.fork_source_kept");
      expect(kept).toHaveLength(1);
      expect(kept[0]?.[1]).toMatchObject({
        name: "node-copy",
        source: "node",
        reason: "the shipped Dockerfile is not a Dockerfile",
      });
      // The image was committed before the recipe was written, so the fork is kept rather than thrown away.
      expect((await l.runtime.inspectImage("mbtest-template:node-copy")).labels[l.keys.templateName]).toBe("node-copy");
    } finally {
      warnings.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
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
const recipePath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/recipe`;
const editPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}`;
const rebuildPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/rebuild`;

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

  test("rebuilding a token's fork keeps its ownership, visibility and copied description", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    const host = harness.app.hosts.get();
    await createDeclaredTemplate(
      host,
      {
        name: "shared",
        source: { kind: "dockerfile", text: FROM_ALPINE },
        description: "Our source description",
        createdBy: "owner",
      },
      {},
    );
    expect(
      (await call(harness.base, forkPath("mbtest-template:shared"), { token: maker.secret, body: { name: "mine" } }))
        .status,
    ).toBe(201);
    expect(namesOf(await call(harness.base, "/api/templates", { token: other.secret }))).not.toContain("mine");
    const rebuilt = await call(harness.base, "/api/templates/mbtest-template%3Amine/rebuild", { body: {} });
    expect(rebuilt.status).toBe(202);
    expect((await finishedTask(harness.base, rebuilt.json.taskId ?? "")).status).toBe("succeeded");
    const image = await harness.runtime.inspectImage("mbtest-template:mine");
    expect(image.labels[host.keys.createdBy]).toBe(maker.id);
    expect(image.labels[host.keys.templateDesc]).toBe("Our source description");
    expect(namesOf(await call(harness.base, "/api/templates", { token: maker.secret }))).toContain("mine");
    expect(namesOf(await call(harness.base, "/api/templates", { token: other.secret }))).not.toContain("mine");
  });

  test("rebuilding an older fork repairs the copied recipe creator from the image's own owner", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const host = harness.app.hosts.get();
    await declaredOverRest("shared");
    expect(
      (await call(harness.base, forkPath("mbtest-template:shared"), { token: maker.secret, body: { name: "mine" } }))
        .status,
    ).toBe(201);
    const recipe = readRecipe(host, "mine")!;
    // The record an earlier version wrote: correct fork image ID, but the source template's creator.
    writeFileSync(
      join(dirname(host.specs.dir()), "template-recipes", host.host.id, "mine.json"),
      JSON.stringify({ ...recipe, createdBy: "owner" }),
    );
    await rebuildDeclaredTemplate(host, await declaredTemplate(host, "mbtest-template:mine"), {});
    expect((await harness.runtime.inspectImage("mbtest-template:mine")).labels[host.keys.createdBy]).toBe(maker.id);
    expect(readRecipe(host, "mine")?.createdBy).toBe(maker.id);
  });

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

  test("a fork of an official template answers buildKind dockerfile and carries the shipped Dockerfile's text", async () => {
    const host = harness.app.hosts.get();
    await createDeclaredTemplate(
      host,
      { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
      {},
    );

    const made = await call(harness.base, forkPath("mbtest-template:node"), { body: { name: "node-copy" } });

    expect(made.status).toBe(201);
    expect((await call(harness.base, recipePath("mbtest-template:node-copy"))).json.recipe).toEqual({
      buildKind: "dockerfile",
      source: { kind: "dockerfile", text: SHIPPED_NODE },
    });
    expect((await call(harness.base, "/api/templates")).json.templates).toContainEqual(
      expect.objectContaining({ ref: "mbtest-template:node-copy", buildKind: "dockerfile" }),
    );
  });

  test("the fork of an official template is edited and rebuilt from the source the edit names", async () => {
    const host = harness.app.hosts.get();
    await createDeclaredTemplate(
      host,
      { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
      {},
    );
    expect((await call(harness.base, forkPath("mbtest-template:node"), { body: { name: "node-copy" } })).status).toBe(
      201,
    );

    const edited = await call(harness.base, editPath("mbtest-template:node-copy"), {
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
    });

    expect(edited.status).toBe(200);
    expect(edited.json.template).toEqual({
      ref: "mbtest-template:node-copy",
      name: "node-copy",
      buildKind: "dockerfile",
    });
    const rebuilt = await call(harness.base, rebuildPath("mbtest-template:node-copy"), { body: {} });
    expect(rebuilt.status).toBe(202);
    expect((await finishedTask(harness.base, rebuilt.json.taskId ?? "")).status).toBe("succeeded");
    expect(harness.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-copy");
    expect(harness.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE_21);
  });

  test("editing the official template's own source is still refused, and its recipe stays official", async () => {
    const host = harness.app.hosts.get();
    await createDeclaredTemplate(
      host,
      { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
      {},
    );

    const edited = await call(harness.base, editPath("mbtest-template:node"), {
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
    });

    expect(refused(edited)).toEqual({ status: 400, key: "template_source_builtin" });
    expect(readRecipe(host, "node")?.source).toEqual({ kind: "official", name: "node" });
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

  test("moving a private source tag to a public image during resolution does not authorize the private image", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    const keys = harness.app.hosts.get().keys;
    const ref = "mbtest-template:private";
    harness.runtime.seedImage(ref, {
      [keys.template]: "true",
      [keys.templateName]: "private",
      [keys.createdBy]: maker.id,
    });
    const inspect = harness.runtime.inspectImage.bind(harness.runtime);
    let moved = false;
    harness.runtime.inspectImage = async (name) => {
      const image = await inspect(name);
      if (name === ref && !moved) {
        moved = true;
        harness.runtime.moveTag(ref, {
          [keys.template]: "true",
          [keys.templateName]: "private",
          [keys.createdBy]: "owner",
        });
      }
      return image;
    };
    const reply = await call(harness.base, forkPath(ref), {
      token: other.secret,
      body: { name: "stolen", host: "local" },
    });
    expect(refused(reply)).toEqual({ status: 403, key: "template_out_of_scope" });
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
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
