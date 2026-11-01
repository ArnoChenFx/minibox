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
import { officialTemplate } from "../src/services/official-templates";
import {
  buildTemplateDraft,
  createDeclaredTemplate,
  declaredTemplate,
  draftTemplate,
  editRecipe,
  readRecipe,
  rebuildDeclaredTemplate,
  type TemplateSource,
  templateSetupOf,
} from "../src/services/template-builds";
import {
  deleteTemplate,
  editTemplate,
  duplicateOfficialTemplate,
  duplicateTemplate,
  listTemplateDrafts,
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

/** The Dockerfile the bundled base template ships with, read from the repository rather than from the service. */
const SHIPPED_BASE = readFileSync(resolve(import.meta.dir, "..", "templates", "base", "Dockerfile"), "utf8");

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

function recipeOnDisk(l: Lab, name: string): { source: unknown; draft?: boolean; imageId?: string | null } {
  return JSON.parse(readFileSync(recipePathOf(l.host, name), "utf8"));
}

const imageGone = (l: Lab, ref: string) =>
  l.runtime.inspectImage(ref).then(
    () => "held",
    () => "gone",
  );

/** The official `node` template, built from the Dockerfile that ships, as `template.official.build` builds it. */
async function officialNode(l: Lab): Promise<void> {
  await createDeclaredTemplate(
    l.host,
    { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
    progressOf(l),
  );
}

/** A duplicate of the official `node` template on `l`, as the console's duplicate action makes one. */
async function duplicateNode(l: Lab, name = "node-copy"): Promise<{ ref: string; name: string }> {
  return duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:node"), {
    name,
    createdBy: "owner",
  });
}

/** A declared template `tool` built from a pasted Dockerfile, which is what a duplicate copies its recipe from. */
async function declared(l: Lab, name = "tool"): Promise<void> {
  await createDeclaredTemplate(
    l.host,
    { name, source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
    progressOf(l),
  );
}

/** Builds the saved draft `name` for the first time, as `template.rebuild` does. */
async function buildDraft(l: Lab, name: string): Promise<{ ref: string; name: string }> {
  const draft = draftTemplate(l.host, name);
  if (!draft) throw new Error(`no draft ${name}`);
  return buildTemplateDraft(l.host, draft, progressOf(l));
}

describe("duplicating a template that was built from a source", () => {
  test("the copy is a draft with no image, and the template it came from is untouched", async () => {
    const l = lab();
    await declared(l);
    const sourceId = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    // The resolution reads the source image; what the duplicate itself does is measured from here on.
    const source = await templateSourceImage(l.host, "mbtest-template:tool");
    const since = l.runtime.calls.length;

    const duplicated = await duplicateTemplate(l.host, source, {
      name: "tool-copy",
      description: "Our own toolchain",
      createdBy: "owner",
    });

    expect(duplicated).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
    expect(readRecipe(l.host, "tool-copy")).toMatchObject({
      version: 1,
      imageId: null,
      draft: true,
      description: "Our own toolchain",
      createdBy: "owner",
      source: { kind: "dockerfile", text: FROM_ALPINE },
    });
    expect(readRecipe(l.host, "tool-copy")?.created).toBeString();
    expect(draftTemplate(l.host, "tool-copy")).not.toBeNull();
    // Nothing was created, committed or built: a draft is a recipe file and nothing else.
    expect(l.runtime.calls.slice(since).map((entry) => entry.op)).toEqual([]);
    expect(l.runtime.containers.size).toBe(0);
    expect(await imageGone(l, "mbtest-template:tool-copy")).toBe("gone");
    // The template list lists images, so the copy is only in the draft list until it is built.
    expect((await listTemplates(l.host)).map((template) => template.name)).not.toContain("tool-copy");
    expect(listTemplateDrafts(l.host)).toContainEqual({
      name: "tool-copy",
      ref: "mbtest-template:tool-copy",
      description: "Our own toolchain",
      buildKind: "dockerfile",
    });
    // The source keeps its image, its tags, its labels and its own recipe.
    const kept = await l.runtime.inspectImage("mbtest-template:tool");
    expect(kept.id).toBe(sourceId);
    expect(kept.tags).toEqual(["mbtest-template:tool"]);
    expect(kept.labels[l.keys.templateName]).toBe("tool");
    expect(kept.labels[l.keys.templateDesc]).toBe("Built from a Dockerfile");
    expect(readRecipe(l.host, "tool")).toMatchObject({
      imageId: sourceId,
      source: { kind: "dockerfile", text: FROM_ALPINE },
    });
    expect(readRecipe(l.host, "tool")).not.toHaveProperty("draft");
  });

  test("every field of the source is copied as it is, the credential name included", async () => {
    const l = lab();
    await declared(l);
    const git: TemplateSource = {
      kind: "git",
      url: "https://github.com/org/app.git",
      branch: "main",
      subdir: "services/api",
      dockerfile: "Dockerfile",
      secretRef: "DEPLOY_TOKEN",
    };
    editRecipe(l.host, await declaredTemplate(l.host, "mbtest-template:tool"), { source: git });

    await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    expect(readRecipe(l.host, "tool-copy")?.source).toEqual(git);
    expect(recipeOnDisk(l, "tool-copy").source).toEqual(git);
  });

  test("a copy with no description copies the source's into the draft", async () => {
    const l = lab();
    await declared(l);

    await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    expect(readRecipe(l.host, "tool-copy")?.description).toBe("Built from a Dockerfile");
  });

  test("the source's setup and ports come along, and the first build keeps them", async () => {
    const l = lab();
    serveRepository(l.runtime, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(l),
    );

    await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:dev"), {
      name: "dev-copy",
      createdBy: "owner",
    });

    expect(readRecipe(l.host, "dev")?.init).toEqual(DEV_SETUP);
    expect(readRecipe(l.host, "dev-copy")?.init).toEqual(DEV_SETUP);
    expect(readRecipe(l.host, "dev-copy")?.draft).toBe(true);
    // A draft has no image, so a box cannot start from it and there is no setup to report until it is built.
    expect(await templateSetupOf(l.host, "mbtest-template:dev-copy")).toBeNull();

    await buildDraft(l, "dev-copy");

    expect(await templateSetupOf(l.host, "mbtest-template:dev-copy")).toEqual(DEV_SETUP);
  });

  test("building the copy makes it a template of its own, and leaves the source where it was", async () => {
    const l = lab();
    await declared(l);
    const sourceBefore = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });
    const buildsBefore = l.runtime.builds.length;
    const draftsBefore = listTemplateDrafts(l.host).length;

    const built = await buildDraft(l, "tool-copy");

    expect(built).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
    expect(l.runtime.builds).toHaveLength(buildsBefore + 1);
    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:tool-copy");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE);
    const image = await l.runtime.inspectImage("mbtest-template:tool-copy");
    expect(readRecipe(l.host, "tool-copy")).toMatchObject({ imageId: image.id });
    expect(readRecipe(l.host, "tool-copy")).not.toHaveProperty("draft");
    expect(draftTemplate(l.host, "tool-copy")).toBeNull();
    expect(listTemplateDrafts(l.host)).toHaveLength(draftsBefore - 1);
    expect((await listTemplates(l.host)).find((template) => template.name === "tool-copy")?.buildKind).toBe(
      "dockerfile",
    );
    // The template the copy came from is not rebuilt, and keeps the image and recipe it had.
    expect((await l.runtime.inspectImage("mbtest-template:tool")).id).toBe(sourceBefore);
    expect(readRecipe(l.host, "tool")?.imageId).toBe(sourceBefore);
  });

  test("a copy saves the recipe the source had when it was resolved, even if the source changes meanwhile", async () => {
    const l = lab();
    await declared(l);
    const source = await templateSourceImage(l.host, "mbtest-template:tool");
    editRecipe(l.host, await declaredTemplate(l.host, "mbtest-template:tool"), {
      source: { kind: "dockerfile", text: FROM_ALPINE_21 },
    });

    await duplicateTemplate(l.host, source, { name: "copy", createdBy: "owner" });

    expect(readRecipe(l.host, "copy")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
    expect(readRecipe(l.host, "tool")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });
  });

  test("deleting the source leaves the copy, which still builds and starts a box", async () => {
    const l = lab();
    await declared(l);
    await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    await deleteTemplate(l.host, "mbtest-template:tool");

    expect(await imageGone(l, "mbtest-template:tool")).toBe("gone");
    expect(readRecipe(l.host, "tool")).toBeNull();
    expect(readRecipe(l.host, "tool-copy")?.draft).toBe(true);
    await buildDraft(l, "tool-copy");
    const box = await boxes.createBox(l.host, {
      name: "beta",
      cpus: 1,
      memoryMb: 256,
      image: "mbtest-template:tool-copy",
    });
    expect(box.template).toBe("mbtest-template:tool-copy");
  });
});

describe("duplicating an official template", () => {
  test("the copy is a draft whose source is a copy of the Dockerfile that ships", async () => {
    const l = lab();
    await officialNode(l);
    // An official template may carry a setup of its own, and a duplicate brings it along.
    editRecipe(l.host, await declaredTemplate(l.host, "mbtest-template:node"), { init: DEV_SETUP });

    await duplicateNode(l);

    // Both the record on disk and what a read makes of it name the copy, so the copy is custom from the moment it exists.
    expect(recipeOnDisk(l, "node-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
    expect(readRecipe(l.host, "node-copy")).toMatchObject({
      imageId: null,
      draft: true,
      init: DEV_SETUP,
      source: { kind: "dockerfile", text: SHIPPED_NODE },
    });
    expect(l.runtime.callsTo("commitContainer")).toHaveLength(0);
    expect(await imageGone(l, "mbtest-template:node-copy")).toBe("gone");
    expect(listTemplateDrafts(l.host)).toContainEqual({
      name: "node-copy",
      ref: "mbtest-template:node-copy",
      description: "Debian 12 · Node.js 26 · pnpm · yarn · git · tmux · build-essential · non-root dev user",
      buildKind: "dockerfile",
    });
    // The template it came from is untouched and still official, with the source it had.
    expect(readRecipe(l.host, "node")?.source).toEqual({ kind: "official", name: "node" });
    expect((await listTemplates(l.host)).find((template) => template.name === "node")?.buildKind).toBe("official");

    await buildDraft(l, "node-copy");

    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_NODE);
    expect((await listTemplates(l.host)).find((template) => template.name === "node-copy")?.buildKind).toBe(
      "dockerfile",
    );
    expect(await templateSetupOf(l.host, "mbtest-template:node-copy")).toEqual(DEV_SETUP);
  });

  test("its source can be replaced once it is built, and a rebuild builds the replacement into the copy's tag", async () => {
    const l = lab();
    await officialNode(l);
    await duplicateNode(l);
    await buildDraft(l, "node-copy");
    const source = await declaredTemplate(l.host, "mbtest-template:node-copy");
    const image = await l.runtime.inspectImage("mbtest-template:node-copy");

    const edited = await editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } });

    expect(edited).toEqual({ ref: "mbtest-template:node-copy", name: "node-copy", buildKind: "dockerfile" });
    expect(readRecipe(l.host, "node-copy")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });

    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:node-copy"), progressOf(l));

    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-copy");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE_21);
  });

  test("the official template's own source stays fixed, so only a copy can be pointed elsewhere", async () => {
    const l = lab();
    await officialNode(l);
    const source = await declaredTemplate(l.host, "mbtest-template:node");
    const image = await l.runtime.inspectImage("mbtest-template:node");

    const error = await rejectionOf(
      editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } }),
    );

    expect(error).toMatchObject({ status: 400, key: "template_source_builtin" });
    expect(readRecipe(l.host, "node")?.source).toEqual({ kind: "official", name: "node" });
    // Its rebuild still builds the Dockerfile this MiniBox ships, not one a copy wrote.
    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:node"), progressOf(l));
    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_NODE);
  });
});

/** The recipe of a duplicate written before a duplicate kept its own copy: an image, still under the official source. */
function seedLegacyDuplicate(l: Lab, name = "node-copy"): string {
  const imageId = l.runtime.seedImage(`mbtest-template:${name}`, {
    [l.keys.template]: "true",
    [l.keys.templateName]: name,
  });
  writeFileSync(
    recipePathOf(l.host, name),
    JSON.stringify({
      version: 1,
      imageId,
      description: null,
      createdBy: "owner",
      created: new Date().toISOString(),
      source: { kind: "official", name: "node" },
    }),
  );
  return imageId;
}

describe("a recipe a duplicate wrote before it kept a copy of the Dockerfile", () => {
  test("reads as the copy of what this MiniBox ships, and the next write stores that copy", async () => {
    const l = lab();
    await officialNode(l);
    seedLegacyDuplicate(l);

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

  test("a rebuild builds the copy of the Dockerfile that ships, and writes that copy back", async () => {
    const l = lab();
    await officialNode(l);
    seedLegacyDuplicate(l);

    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:node-copy"), progressOf(l));

    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-copy");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_NODE);
    // The rebuild writes back what it read, so the record now holds the copy instead of the old official source.
    expect(recipeOnDisk(l, "node-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_NODE });
  });

  test("a Dockerfile that cannot become the copy keeps the official source, warns, and keeps the image copy", async () => {
    // A MiniBox whose shipped Dockerfile is not a Dockerfile: a draft cannot take that source.
    const dir = mkdtempSync(join(tmpdir(), "minibox-templates-"));
    mkdirSync(join(dir, "official", "node"), { recursive: true });
    writeFileSync(join(dir, "official", "node", "Dockerfile"), "RUN true\n");
    const { app, runtime } = createTestApp({ templatesDir: dir, labelPrefix: "mbtest" });
    const host = app.hosts.get();
    runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
    const l: Lab = { app, runtime, host, keys: host.keys, progress: [] };
    const warnings = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await officialNode(l);
      const duplicated = await duplicateNode(l);

      expect(duplicated).toEqual({ ref: "mbtest-template:node-copy", name: "node-copy" });
      // A draft cannot name an official source, so this copy is the image copy a duplicate has always been.
      expect(readRecipe(l.host, "node-copy")).toMatchObject({ source: { kind: "official", name: "node" } });
      expect(readRecipe(l.host, "node-copy")?.draft).toBeUndefined();
      const kept = warnings.mock.calls.filter(([event]) => event === "template.duplicate_source_kept");
      expect(kept).toHaveLength(1);
      expect(kept[0]?.[1]).toMatchObject({
        name: "node-copy",
        source: "node",
        reason: "the shipped Dockerfile is not a Dockerfile",
      });
      // The image was committed before the recipe was written, so the copy is kept rather than thrown away.
      expect((await l.runtime.inspectImage("mbtest-template:node-copy")).labels[l.keys.templateName]).toBe("node-copy");
      expect(readRecipe(l.host, "node-copy")?.imageId).toBe(
        (await l.runtime.inspectImage("mbtest-template:node-copy")).id,
      );
    } finally {
      warnings.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("duplicating an official template no host has built yet", () => {
  test("the copy is a draft from a copy of the Dockerfile that ships, and no engine call is made", async () => {
    const l = lab();
    const official = officialTemplate("node");
    if (!official) throw new Error("the node template ships");

    const duplicated = duplicateOfficialTemplate(l.host, official, { name: "node-mine", createdBy: "owner" });

    expect(duplicated).toEqual({ ref: "mbtest-template:node-mine", name: "node-mine" });
    expect(readRecipe(l.host, "node-mine")).toMatchObject({
      version: 1,
      imageId: null,
      draft: true,
      description: official.description,
      createdBy: "owner",
      source: { kind: "dockerfile", text: SHIPPED_NODE },
    });
    expect(l.runtime.callsTo("createContainer")).toHaveLength(0);
    expect(l.runtime.callsTo("commitContainer")).toHaveLength(0);
    expect(l.runtime.callsTo("buildImage")).toHaveLength(0);
    expect(listTemplateDrafts(l.host)).toContainEqual({
      name: "node-mine",
      ref: "mbtest-template:node-mine",
      description: official.description,
      buildKind: "dockerfile",
    });
    // The official template itself is still not built on this host.
    expect(await imageGone(l, "mbtest-template:node")).toBe("gone");
  });

  test("a description the caller gives replaces the catalog's", () => {
    const l = lab();
    const official = officialTemplate("go");
    if (!official) throw new Error("the go template ships");

    duplicateOfficialTemplate(l.host, official, { name: "go-mine", description: "Ours", createdBy: "owner" });

    expect(readRecipe(l.host, "go-mine")?.description).toBe("Ours");
  });

  test("building the draft gives the official template's own copy as a custom template", async () => {
    const l = lab();
    const official = officialTemplate("node");
    if (!official) throw new Error("the node template ships");
    duplicateOfficialTemplate(l.host, official, { name: "node-mine", createdBy: "owner" });

    await buildDraft(l, "node-mine");

    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-mine");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_NODE);
    expect((await listTemplates(l.host)).find((template) => template.name === "node-mine")?.buildKind).toBe(
      "dockerfile",
    );
    // Building the copy never built the official template itself.
    expect(await imageGone(l, "mbtest-template:node")).toBe("gone");
  });

  test("a Dockerfile this MiniBox cannot read fails the copy and leaves no recipe behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-templates-"));
    mkdirSync(join(dir, "official", "node"), { recursive: true });
    writeFileSync(join(dir, "official", "node", "Dockerfile"), "RUN true\n");
    const { app, runtime } = createTestApp({ templatesDir: dir, labelPrefix: "mbtest" });
    const host = app.hosts.get();
    const l: Lab = { app, runtime, host, keys: host.keys, progress: [] };
    const warnings = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const official = officialTemplate("node");
      if (!official) throw new Error("the node template ships");

      const error = await rejectionOf(
        (async () => duplicateOfficialTemplate(l.host, official, { name: "node-mine", createdBy: "owner" }))(),
      );

      expect(error).toMatchObject({ status: 500, key: "template_source_unreadable", params: { name: "node" } });
      expect(draftTemplate(l.host, "node-mine")).toBeNull();
      expect(listTemplateDrafts(l.host)).toEqual([]);
      expect(l.runtime.callsTo("createContainer")).toHaveLength(0);
      expect(l.runtime.callsTo("buildImage")).toHaveLength(0);
      const missing = warnings.mock.calls.filter(([event]) => event === "template.duplicate_source_missing");
      expect(missing).toHaveLength(1);
    } finally {
      warnings.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("duplicating a template that was saved from a box", () => {
  test("the copy is a working template with no build kind, and it has no recipe to rebuild from", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    await saveBoxAsTemplate(l.host, box.boxId, { name: "gold", description: "Node 26 toolchain" }, "owner");

    const duplicated = await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:gold"), {
      name: "gold-copy",
      createdBy: "owner",
    });

    expect(duplicated.ref).toBe("mbtest-template:gold-copy");
    const listed = (await listTemplates(l.host)).find((template) => template.name === "gold-copy");
    expect(listed).toMatchObject({ ref: "mbtest-template:gold-copy", description: "Node 26 toolchain" });
    expect(listed).not.toHaveProperty("buildKind");
    // A copy names no box, so it is not a save of the box the original came from.
    expect(listed?.source).toBeNull();
    expect(listed?.sourceId).toBeNull();
    expect(readRecipe(l.host, "gold-copy")).toBeNull();
    expect(listDraftTemplateNames(l)).not.toContain("gold-copy");
    const recipeError = await rejectionOf(declaredTemplate(l.host, "mbtest-template:gold-copy"));
    expect(recipeError).toMatchObject({ status: 400, key: "template_not_declared" });
    // The original keeps naming the box it was saved from.
    const source = (await listTemplates(l.host)).find((template) => template.name === "gold");
    expect(source).toMatchObject({ source: "alpha", sourceId: box.boxId });
  });

  test("a copy of a saved template commits an image, as it always did", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    await saveBoxAsTemplate(l.host, box.boxId, { name: "gold" }, "owner");
    const sourceId = (await l.runtime.inspectImage("mbtest-template:gold")).id;

    await duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:gold"), {
      name: "gold-copy",
      description: "Ours",
      createdBy: "owner",
    });

    const made = await l.runtime.inspectImage("mbtest-template:gold-copy");
    expect(made.id).not.toBe(sourceId);
    expect(made.labels).toMatchObject({
      [l.keys.template]: "true",
      [l.keys.templateName]: "gold-copy",
      [l.keys.templateDesc]: "Ours",
      [l.keys.createdBy]: "owner",
      [l.keys.snapshot]: "false",
    });
    expect(readRecipe(l.host, "gold-copy")).toBeNull();
  });
});

describe("the template a duplicate copies", () => {
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

  test("is not a snapshot or a plain image, so a duplicate never copies those", async () => {
    const l = lab();
    l.runtime.seedImage("mbtest-snap:nightly", { [l.keys.snapshot]: "true" });
    expect(await rejectionOf(templateSourceImage(l.host, "mbtest-snap:nightly"))).toMatchObject({
      status: 404,
      key: "template_not_found",
    });
  });
});

describe("a copy that fails", () => {
  test("an image copy leaves no image and no recipe, so the name stays free", async () => {
    const l = lab();
    // A template saved from a box: an image with the template labels and no recipe, which a copy commits anew.
    l.runtime.seedImage("mbtest-template:gold", { [l.keys.template]: "true", [l.keys.templateName]: "gold" });
    l.runtime.fail("commitContainer", new RuntimeError("engine", "no space left on device"));

    const error = await rejectionOf(
      duplicateTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:gold"), {
        name: "gold-copy",
        createdBy: "owner",
      }),
    );

    expect(error).toBeInstanceOf(RuntimeError);
    expect(await imageGone(l, "mbtest-template:gold-copy")).toBe("gone");
    expect(readRecipe(l.host, "gold-copy")).toBeNull();
    expect(l.runtime.containers.size).toBe(0);
  });
});

const listDraftTemplateNames = (l: Lab) => listTemplateDrafts(l.host).map((draft) => draft.name);

/** A duplicate of the bundled base template on `l`, as the console's duplicate action makes one. */
const duplicateBase = async (l: Lab, name = "base-copy") =>
  duplicateTemplate(l.host, await templateSourceImage(l.host, l.host.baseTemplateTag), { name, createdBy: "owner" });

describe("duplicating the bundled base template", () => {
  test("the copy is a draft whose source is its own copy of the base Dockerfile, and the base template is untouched", async () => {
    const l = lab();

    await duplicateBase(l);

    expect(recipeOnDisk(l, "base-copy").source).toEqual({ kind: "dockerfile", text: SHIPPED_BASE });
    expect(readRecipe(l.host, "base-copy")).toMatchObject({ imageId: null, draft: true });
    expect(l.runtime.callsTo("commitContainer")).toHaveLength(0);
    expect(await imageGone(l, "mbtest-template:base-copy")).toBe("gone");
    expect(listTemplateDrafts(l.host)[0]).toMatchObject({ name: "base-copy", buildKind: "dockerfile" });
    // The base template is built by MiniBox itself and still has no recipe.
    expect(readRecipe(l.host, "base")).toBeNull();
    expect((await listTemplates(l.host)).find((template) => template.name === "base")?.buildKind).toBeUndefined();
  });

  test("building the copy builds the base Dockerfile into the copy's own tag", async () => {
    const l = lab();
    await duplicateBase(l);

    await buildDraft(l, "base-copy");

    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:base-copy");
    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(SHIPPED_BASE);
  });

  test("a MiniBox that cannot read the base Dockerfile still copies it as an image, warns, and leaves no recipe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-templates-"));
    const { app, runtime } = createTestApp({ templatesDir: dir, labelPrefix: "mbtest" });
    const host = app.hosts.get();
    runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
    const l: Lab = { app, runtime, host, keys: host.keys, progress: [] };
    const warnings = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await duplicateBase(l);

      expect(readRecipe(l.host, "base-copy")).toBeNull();
      const missing = warnings.mock.calls.filter(([event]) => event === "template.duplicate_source_missing");
      expect(missing).toHaveLength(1);
      expect(missing[0]?.[1]).toMatchObject({ name: "base-copy", source: "base" });
      expect((await l.runtime.inspectImage("mbtest-template:base-copy")).labels[l.keys.templateName]).toBe("base-copy");
    } finally {
      warnings.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function namesOf(reply: Reply): (string | null)[] {
  return (reply.json.templates ?? []).map((template) => template.name);
}

const duplicatePath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/duplicate`;
const recipePath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/recipe`;
const editPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}`;
const rebuildPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/rebuild`;

describe("template.duplicate over REST and tokens", () => {
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

  async function rebuildOverRest(name: string): Promise<void> {
    const rebuilt = await call(harness.base, rebuildPath(`mbtest-template:${name}`), { body: {} });
    expect(rebuilt.status).toBe(202);
    expect((await finishedTask(harness.base, rebuilt.json.taskId ?? "")).status).toBe("succeeded");
  }

  test("rebuilding a token's copy keeps its ownership, visibility and copied description", async () => {
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
      (
        await call(harness.base, duplicatePath("mbtest-template:shared"), {
          token: maker.secret,
          body: { name: "mine" },
        })
      ).status,
    ).toBe(201);
    // The copy of a declared template is a draft, so it is not listed until it is built.
    expect(namesOf(await call(harness.base, "/api/templates", { token: other.secret }))).not.toContain("mine");
    expect(readRecipe(host, "mine")).toMatchObject({ draft: true, createdBy: maker.id });
    await rebuildOverRest("mine");
    const image = await harness.runtime.inspectImage("mbtest-template:mine");
    expect(image.labels[host.keys.createdBy]).toBe(maker.id);
    expect(image.labels[host.keys.templateDesc]).toBe("Our source description");
    expect(namesOf(await call(harness.base, "/api/templates", { token: maker.secret }))).toContain("mine");
    expect(namesOf(await call(harness.base, "/api/templates", { token: other.secret }))).not.toContain("mine");
  });

  test("rebuilding an older copy repairs the copied recipe creator from the image's own owner", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const host = harness.app.hosts.get();
    await declaredOverRest("shared");
    expect(
      (
        await call(harness.base, duplicatePath("mbtest-template:shared"), {
          token: maker.secret,
          body: { name: "mine" },
        })
      ).status,
    ).toBe(201);
    await rebuildOverRest("mine");
    const recipe = readRecipe(host, "mine")!;
    // The record an earlier version wrote: correct duplicate image ID, but the source template's creator.
    writeFileSync(
      join(dirname(host.specs.dir()), "template-recipes", host.host.id, "mine.json"),
      JSON.stringify({ ...recipe, createdBy: "owner" }),
    );
    await rebuildDeclaredTemplate(host, await declaredTemplate(host, "mbtest-template:mine"), {});
    expect((await harness.runtime.inspectImage("mbtest-template:mine")).labels[host.keys.createdBy]).toBe(maker.id);
    expect(readRecipe(host, "mine")?.createdBy).toBe(maker.id);
  });

  test("answers 201 with the new template, which lists as a draft until it is built", async () => {
    await declaredOverRest("tool");

    const made = await call(harness.base, duplicatePath("mbtest-template:tool"), {
      body: { name: "tool-copy", description: "Our own toolchain" },
    });

    expect(made.status).toBe(201);
    expect(made.json.template).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
    const drafts = await call(harness.base, "/api/templates/drafts");
    expect(drafts.json.templates).toContainEqual(
      expect.objectContaining({
        name: "tool-copy",
        description: "Our own toolchain",
        buildKind: "dockerfile",
      }),
    );
    expect(namesOf(await call(harness.base, "/api/templates"))).not.toContain("tool-copy");

    await rebuildOverRest("tool-copy");

    expect((await call(harness.base, "/api/templates")).json.templates).toContainEqual(
      expect.objectContaining({
        ref: "mbtest-template:tool-copy",
        name: "tool-copy",
        description: "Our own toolchain",
        buildKind: "dockerfile",
      }),
    );
  });

  test("a copy of an official template is a draft carrying the shipped Dockerfile's text", async () => {
    const host = harness.app.hosts.get();
    await createDeclaredTemplate(
      host,
      { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
      {},
    );

    const made = await call(harness.base, duplicatePath("mbtest-template:node"), { body: { name: "node-copy" } });

    expect(made.status).toBe(201);
    expect((await call(harness.base, recipePath("mbtest-template:node-copy"))).json.recipe).toEqual({
      buildKind: "dockerfile",
      source: { kind: "dockerfile", text: SHIPPED_NODE },
    });
    expect(namesOf(await call(harness.base, "/api/templates"))).not.toContain("node-copy");
    expect((await call(harness.base, "/api/templates/drafts")).json.templates).toContainEqual(
      expect.objectContaining({ name: "node-copy", buildKind: "dockerfile" }),
    );
  });

  test("an official template no host has built can be copied into a draft over REST", async () => {
    const made = await call(harness.base, duplicatePath("mbtest-template:node"), { body: { name: "node-mine" } });

    expect(made.status).toBe(201);
    expect(made.json.template).toEqual({ ref: "mbtest-template:node-mine", name: "node-mine" });
    expect((await call(harness.base, recipePath("mbtest-template:node-mine"))).json.recipe).toEqual({
      buildKind: "dockerfile",
      source: { kind: "dockerfile", text: SHIPPED_NODE },
    });
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(0);
    expect(namesOf(await call(harness.base, "/api/templates"))).not.toContain("node");
    expect((await call(harness.base, "/api/templates/drafts")).json.templates).toContainEqual(
      expect.objectContaining({ name: "node-mine", description: officialTemplate("node")?.description }),
    );

    await rebuildOverRest("node-mine");

    expect(harness.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-mine");
    expect(namesOf(await call(harness.base, "/api/templates"))).toContain("node-mine");
    // The official template still has no image of its own on this host.
    expect(
      await harness.runtime.inspectImage("mbtest-template:node").then(
        () => "held",
        () => "gone",
      ),
    ).toBe("gone");
  });

  test("a name MiniBox keeps for an official template is refused for the copy", async () => {
    const reply = await call(harness.base, duplicatePath("mbtest-template:node"), { body: { name: "node" } });

    expect(refused(reply)).toEqual({ status: 409, key: "template_name_reserved" });
    expect(harness.runtime.callsTo("createContainer")).toHaveLength(0);
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
    expect((await call(harness.base, "/api/templates/drafts")).json.templates).toEqual([]);
  });

  test("the copy of an unbuilt official template is edited and rebuilt from the source the edit names", async () => {
    expect(
      (await call(harness.base, duplicatePath("mbtest-template:node"), { body: { name: "node-copy" } })).status,
    ).toBe(201);

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
    await rebuildOverRest("node-copy");
    expect(harness.runtime.builds.at(-1)?.tag).toBe("mbtest-template:node-copy");
    expect(harness.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE_21);
  });

  test("the copy of the bundled base template is edited and rebuilt from the source the edit names", async () => {
    const base = harness.app.hosts.get().baseTemplateTag;

    const made = await call(harness.base, duplicatePath(base), { body: { name: "base-copy" } });

    expect(made.status).toBe(201);
    expect((await call(harness.base, recipePath("mbtest-template:base-copy"))).json.recipe).toEqual({
      buildKind: "dockerfile",
      source: { kind: "dockerfile", text: SHIPPED_BASE },
    });
    expect((await call(harness.base, "/api/templates/drafts")).json.templates).toContainEqual(
      expect.objectContaining({ name: "base-copy", buildKind: "dockerfile" }),
    );
    const edited = await call(harness.base, editPath("mbtest-template:base-copy"), {
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
    });
    expect(edited.status).toBe(200);
    await rebuildOverRest("base-copy");
    expect(harness.runtime.builds.at(-1)?.tag).toBe("mbtest-template:base-copy");
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

    const made = await call(harness.base, duplicatePath("tool"), { body: { name: "tool-copy" } });

    expect(made.status).toBe(201);
    expect(made.json.template).toEqual({ ref: "mbtest-template:tool-copy", name: "tool-copy" });
  });

  test("a copy is recorded in the activity feed under the new name, which the console draws an icon and a label for", async () => {
    await declaredOverRest("tool");

    const made = await call(harness.base, duplicatePath("mbtest-template:tool"), { body: { name: "tool-copy" } });

    expect(made.status).toBe(201);
    expect(harness.app.activity.list()[0]).toMatchObject({
      action: "template.duplicate",
      target: "tool-copy",
      ok: true,
    });
  });

  test("a name an image holds is refused as a conflict, and nothing is committed", async () => {
    await declaredOverRest("tool");
    await declaredOverRest("tool-copy");
    const since = harness.runtime.calls.length;

    const again = await call(harness.base, duplicatePath("mbtest-template:tool"), { body: { name: "tool-copy" } });

    expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
    expect(harness.runtime.calls.slice(since).map((entry) => entry.op)).not.toContain("commitContainer");
  });

  test("a name a draft holds is refused as a conflict, and the draft is left as it is", async () => {
    await declaredOverRest("tool");
    expect(
      (await call(harness.base, duplicatePath("mbtest-template:tool"), { body: { name: "tool-copy" } })).status,
    ).toBe(201);
    const recipe = readRecipe(harness.app.hosts.get(), "tool-copy");

    const again = await call(harness.base, duplicatePath("mbtest-template:tool"), {
      body: { name: "tool-copy", description: "Replaced" },
    });

    expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
    expect(readRecipe(harness.app.hosts.get(), "tool-copy")).toEqual(recipe);
  });

  test("a template that does not exist is not found, and a base name that is not official is not copied either", async () => {
    const missing = await call(harness.base, duplicatePath("mbtest-template:nowhere"), { body: { name: "copy" } });
    expect(refused(missing)).toEqual({ status: 404, key: "template_not_found" });
    const plain = await call(harness.base, duplicatePath("nowhere"), { body: { name: "copy" } });
    expect(refused(plain)).toEqual({ status: 404, key: "template_not_found" });
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
  });

  test("the old /fork path is gone, so a script that still names it gets a 404", async () => {
    await declaredOverRest("tool");

    const old = await call(harness.base, "/api/templates/mbtest-template%3Atool/fork", { body: { name: "tool-copy" } });

    expect(refused(old)).toEqual({ status: 404, key: "api_not_found" });
    expect(readRecipe(harness.app.hosts.get(), "tool-copy")).toBeNull();
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
  });

  test("a copy of a saved template works and cannot be rebuilt, as the template it came from could not", async () => {
    const box = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    const saved = await call(harness.base, `/api/boxes/${box.json.box?.boxId ?? ""}/template`, {
      body: { name: "gold" },
    });
    expect((await finishedTask(harness.base, saved.json.taskId ?? "")).status).toBe("succeeded");

    const made = await call(harness.base, duplicatePath("mbtest-template:gold"), { body: { name: "gold-copy" } });

    expect(made.status).toBe(201);
    const rebuild = await call(harness.base, rebuildPath("mbtest-template:gold-copy"), { body: {} });
    expect(refused(rebuild)).toEqual({ status: 400, key: "template_not_declared" });
  });

  test("deleting the source after a copy leaves the draft, which still builds", async () => {
    await declaredOverRest("tool");
    expect(
      (await call(harness.base, duplicatePath("mbtest-template:tool"), { body: { name: "tool-copy" } })).status,
    ).toBe(201);

    const removed = await call(harness.base, `/api/templates/${encodeURIComponent("mbtest-template:tool")}`, {
      method: "DELETE",
    });

    expect(removed.status).toBe(200);
    expect(namesOf(await call(harness.base, "/api/templates"))).toEqual(["base"]);
    expect((await call(harness.base, "/api/templates/drafts")).json.templates).toContainEqual(
      expect.objectContaining({ name: "tool-copy" }),
    );
    await rebuildOverRest("tool-copy");
    expect(namesOf(await call(harness.base, "/api/templates"))).toEqual(["tool-copy", "base"]);
  });

  test("a token may copy a template it can see into a free name, and may not copy another principal's template", async () => {
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

    const mine = await call(harness.base, duplicatePath("mbtest-template:shared"), {
      token: maker.secret,
      body: { name: "shared-copy" },
    });
    expect(mine.status).toBe(201);
    // A declared source is copied as a draft, owned by the token that asked, and no image is committed.
    const commits = harness.runtime.callsTo("commitContainer");
    expect(
      commits.filter((entry) => (entry.args[1] as { tag?: string } | undefined)?.tag === "shared-copy"),
    ).toHaveLength(0);
    expect(readRecipe(harness.app.hosts.get(), "shared-copy")).toMatchObject({ draft: true, createdBy: maker.id });

    const stolen = await call(harness.base, duplicatePath("mbtest-template:makers"), {
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
    const reply = await call(harness.base, duplicatePath(ref), {
      token: other.secret,
      body: { name: "stolen", host: "local" },
    });
    expect(refused(reply)).toEqual({ status: 403, key: "template_out_of_scope" });
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
  });

  test("a token may not copy into a name another principal holds", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    await declaredOverRest("shared");
    expect(
      (
        await call(harness.base, duplicatePath("mbtest-template:shared"), {
          token: maker.secret,
          body: { name: "mine" },
        })
      ).status,
    ).toBe(201);

    const clash = await call(harness.base, duplicatePath("mbtest-template:shared"), {
      token: other.secret,
      body: { name: "mine" },
    });

    expect(refused(clash)).toEqual({ status: 403, key: "template_out_of_scope" });
  });

  test("a sandboxed agent may not copy a template", async () => {
    const sandboxed = mint(harness.app, { name: "sandboxed", preset: "sandboxed-agent" });
    await declaredOverRest("tool");
    const reply = await call(harness.base, duplicatePath("mbtest-template:tool"), {
      token: sandboxed.secret,
      body: { name: "tool-copy" },
    });
    expect(refused(reply)).toEqual({ status: 403, key: "operation_forbidden" });
  });
});

describe("deleting a template", () => {
  test("the bundled base template is refused by its tag, by its bare name and by its image id", async () => {
    const l = lab();
    const base = await l.runtime.inspectImage(l.host.baseTemplateTag);

    for (const ref of [l.host.baseTemplateTag, "base", base.id]) {
      expect(await rejectionOf(deleteTemplate(l.host, ref))).toMatchObject({ status: 409, key: "template_builtin" });
    }

    // Nothing was touched: the image the helpers, volumes and egress proxy run on is still there.
    expect(l.runtime.callsTo("removeImage")).toHaveLength(0);
    expect((await l.runtime.inspectImage(l.host.baseTemplateTag)).id).toBe(base.id);
    expect((await listTemplates(l.host)).map((template) => template.ref)).toContain(l.host.baseTemplateTag);
  });

  test("an image the engine keeps, as one another image is built on, is refused instead of reported deleted", async () => {
    const l = lab();
    await declared(l);
    const image = await l.runtime.inspectImage("mbtest-template:tool");
    // Docker removes only the tag of an image another image is built on and reports success; the image stays.
    const removeImage = spyOn(l.runtime, "removeImage").mockImplementation(async () => {});

    expect(await rejectionOf(deleteTemplate(l.host, image.id))).toMatchObject({
      status: 409,
      key: "template_still_used",
    });

    expect(removeImage).toHaveBeenCalled();
    // The recipe stays too: the template is still there, so its source must not be forgotten.
    expect(readRecipe(l.host, "tool")?.imageId).toBe(image.id);
    expect(recipeOnDisk(l, "tool").imageId).toBe(image.id);
  });

  test("deleting by image id removes the recipe that built that image", async () => {
    const l = lab();
    await declared(l);
    const image = await l.runtime.inspectImage("mbtest-template:tool");

    await deleteTemplate(l.host, image.id);

    expect(await imageGone(l, image.id)).toBe("gone");
    expect(readRecipe(l.host, "tool")).toBeNull();
  });

  test("deleting by image id keeps a recipe of the same name that built another image", async () => {
    const l = lab();
    await declared(l);
    const image = await l.runtime.inspectImage("mbtest-template:tool");
    const recipe = recipeOnDisk(l, "tool");
    writeFileSync(recipePathOf(l.host, "tool"), JSON.stringify({ ...recipe, imageId: "sha256:another" }));

    await deleteTemplate(l.host, image.id);

    expect(await imageGone(l, image.id)).toBe("gone");
    expect(recipeOnDisk(l, "tool").imageId).toBe("sha256:another");
  });
});
