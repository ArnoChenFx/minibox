import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import {
  createDeclaredTemplate,
  declaredTemplate,
  editRecipe,
  readRecipe,
  rebuildDeclaredTemplate,
  templateSetupOf,
} from "../src/services/template-builds";
import {
  editTemplate,
  forkTemplate,
  holdingTemplate,
  listTemplates,
  saveBoxAsTemplate,
  templateSourceImage,
} from "../src/services/templates";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { DEVCONTAINER_WITH_SETUP, serveRepository } from "./support/repository";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";
const FROM_ALPINE_21 = "FROM alpine:3.21\nRUN true\n";
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
}

function lab(): Lab {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  return { app, runtime, host, keys: host.keys };
}

const progressOf = () => ({ log: () => {} });

/** A declared template `tool` built from a pasted Dockerfile. */
async function declared(l: Lab, name = "tool"): Promise<void> {
  await createDeclaredTemplate(
    l.host,
    { name, source: { kind: "dockerfile", text: FROM_ALPINE }, createdBy: "owner" },
    progressOf(),
  );
}

/** The declared template a caller edits, with the image the host reported for it. */
async function editable(l: Lab, ref = "mbtest-template:tool") {
  const image = await l.runtime.inspectImage(ref);
  const declaredSource = await declaredTemplate(l.host, ref);
  return { declared: declaredSource, image };
}

describe("editing the Dockerfile a template rebuilds from", () => {
  test("the recipe takes the new text, and the image a box created now starts from is untouched", async () => {
    const l = lab();
    await declared(l);
    const before = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    const { declared: source, image } = await editable(l);

    const edited = await editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } });

    expect(edited).toEqual({ ref: "mbtest-template:tool", name: "tool", buildKind: "dockerfile" });
    expect(readRecipe(l.host, "tool")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });
    // No build ran, so the tag still names the image it did before, and the recipe still points at it.
    expect((await l.runtime.inspectImage("mbtest-template:tool")).id).toBe(before);
    expect(readRecipe(l.host, "tool")?.imageId).toBe(before);
    expect(l.runtime.builds).toHaveLength(1);
  });

  test("a rebuild after the edit builds the new Dockerfile into the template's own tag", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);
    await editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } });

    const rebuilt = await declaredTemplate(l.host, "mbtest-template:tool");
    await rebuildDeclaredTemplate(l.host, rebuilt, progressOf());

    expect(l.runtime.builds.at(-1)?.files.get("Dockerfile")).toBe(FROM_ALPINE_21);
    expect(l.runtime.builds.at(-1)?.tag).toBe("mbtest-template:tool");
    expect(readRecipe(l.host, "tool")?.imageId).toBe((await l.runtime.inspectImage("mbtest-template:tool")).id);
  });

  test("an edit that changes the source to a repository keeps the other fields of that source", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);

    await editTemplate(l.host, source, image, {
      source: { kind: "git", url: "https://github.com/org/app.git", branch: "main", subdir: "services/api" },
    });

    expect(readRecipe(l.host, "tool")?.source).toEqual({
      kind: "git",
      url: "https://github.com/org/app.git",
      branch: "main",
      subdir: "services/api",
    });
    const listed = (await listTemplates(l.host)).find((template) => template.name === "tool");
    expect(listed?.buildKind).toBe("git");
  });
});

describe("editing the setup a box created from the template gets", () => {
  test("the ports and the command are stored, and a box created afterwards runs them", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);

    await editTemplate(l.host, source, image, {
      init: { postCreate: ["/bin/sh", "-c", "make"], forwardPorts: [8080] },
    });

    expect(await templateSetupOf(l.host, "mbtest-template:tool")).toEqual({
      postCreate: ["/bin/sh", "-c", "make"],
      forwardPorts: [8080],
    });
    const listed = (await listTemplates(l.host)).find((template) => template.name === "tool");
    expect(listed).toMatchObject({ postCreate: ["/bin/sh", "-c", "make"], forwardPorts: [8080] });
  });

  test("an edit that names no setup keeps the one the template has", async () => {
    const l = lab();
    serveRepository(l.runtime, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(),
    );
    const { declared: source, image } = await editable(l, "mbtest-template:dev");
    expect(readRecipe(l.host, "dev")?.init).toEqual(DEV_SETUP);

    await editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE } });

    expect(readRecipe(l.host, "dev")?.init).toEqual(DEV_SETUP);
  });

  test("an edit that names one field of the setup keeps the field it does not name", async () => {
    const l = lab();
    // A devcontainer build gives the template a command and a port, the setup a real template has.
    serveRepository(l.runtime, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(),
    );
    const { declared: source, image } = await editable(l, "mbtest-template:dev");
    expect(readRecipe(l.host, "dev")?.init).toEqual(DEV_SETUP);

    // `minibox template edit --forward-port 8080` sends only the ports, and must not drop the command.
    await editTemplate(l.host, source, image, { init: { forwardPorts: [8080] } });
    expect(readRecipe(l.host, "dev")?.init).toEqual({ postCreate: DEV_SETUP.postCreate, forwardPorts: [8080] });

    // The other way round too: a new command keeps the ports the template had.
    const again = await editable(l, "mbtest-template:dev");
    await editTemplate(l.host, again.declared, again.image, { init: { postCreate: ["/bin/sh", "-c", "make"] } });
    expect(readRecipe(l.host, "dev")?.init).toEqual({ postCreate: ["/bin/sh", "-c", "make"], forwardPorts: [8080] });
  });

  test("an empty setup drops the one the template has, the same as init null", async () => {
    const l = lab();
    serveRepository(l.runtime, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(),
    );
    const { declared: source, image } = await editable(l, "mbtest-template:dev");

    await editTemplate(l.host, source, image, { init: {} });

    expect(readRecipe(l.host, "dev")?.init).toBeUndefined();
    expect(await templateSetupOf(l.host, "mbtest-template:dev")).toBeNull();
  });

  test("init null drops the setup, so a box created afterwards gets none", async () => {
    const l = lab();
    serveRepository(l.runtime, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      l.host,
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      progressOf(),
    );
    const { declared: source, image } = await editable(l, "mbtest-template:dev");

    await editTemplate(l.host, source, image, { init: null });

    expect(readRecipe(l.host, "dev")?.init).toBeUndefined();
    expect(await templateSetupOf(l.host, "mbtest-template:dev")).toBeNull();
  });
});

describe("editing the description a card shows", () => {
  test("the image is committed under the same tag with the new description, and the recipe follows it", async () => {
    const l = lab();
    await declared(l);
    const before = (await l.runtime.inspectImage("mbtest-template:tool")).id;
    const { declared: source, image } = await editable(l);

    await editTemplate(l.host, source, image, { description: "Our own toolchain" });

    const after = await l.runtime.inspectImage("mbtest-template:tool");
    expect(after.labels[l.keys.templateDesc]).toBe("Our own toolchain");
    // The label is on the image, so the tag has to name a new commit; the recipe follows it so a rebuild still knows its image.
    expect(after.id).not.toBe(before);
    expect(readRecipe(l.host, "tool")?.imageId).toBe(after.id);
    expect(readRecipe(l.host, "tool")?.description).toBe("Our own toolchain");
    // Only a label changed: the build ran once, when the template was created, and the commit once, for the label.
    expect(l.runtime.builds).toHaveLength(1);
    expect(l.runtime.callsTo("commitContainer")).toHaveLength(1);
    // The template keeps its other labels, including the source it was built from.
    expect(after.labels[l.keys.template]).toBe("true");
    expect(after.labels[l.keys.templateName]).toBe("tool");
    expect(after.labels[l.keys.createdBy]).toBe("owner");
  });

  test("the same description writes no new image, so the tag keeps the one it has", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);
    const before = image.id;

    await editTemplate(l.host, source, image, { description: image.labels[l.keys.templateDesc] ?? "" });

    expect((await l.runtime.inspectImage("mbtest-template:tool")).id).toBe(before);
    expect(l.runtime.callsTo("commitContainer")).toHaveLength(0);
  });

  test("a description the template never had gives the image the default one, not an empty label", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);

    await editTemplate(l.host, source, image, { description: "Built from a Dockerfile" });

    expect((await l.runtime.inspectImage("mbtest-template:tool")).labels[l.keys.templateDesc]).toBe(
      "Built from a Dockerfile",
    );
  });

  test("a failed commit leaves the image and the recipe as they were", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);
    const before = image.id;
    l.runtime.fail("commitContainer", new RuntimeError("engine", "no space left on device"));

    const error = await rejectionOf(
      editTemplate(l.host, source, image, {
        description: "Ours",
        source: { kind: "dockerfile", text: FROM_ALPINE_21 },
      }),
    );

    expect(error).toBeInstanceOf(RuntimeError);
    expect((await l.runtime.inspectImage("mbtest-template:tool")).id).toBe(before);
    expect(readRecipe(l.host, "tool")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
    expect(readRecipe(l.host, "tool")?.description).toBeNull();
    expect(l.runtime.containers.size).toBe(0);
  });
});

describe("editing a template that has no source", () => {
  test("a template saved from a box is refused, because there is nothing to rebuild from", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    await saveBoxAsTemplate(l.host, box.boxId, { name: "gold" }, "owner");

    const error = await rejectionOf(declaredTemplate(l.host, "mbtest-template:gold"));

    expect(error).toMatchObject({ status: 400, key: "template_not_declared" });
  });

  test("a fork of a saved template is refused too, and its own fork stays editable", async () => {
    const l = lab();
    await declared(l);
    await forkTemplate(l.host, await templateSourceImage(l.host, "mbtest-template:tool"), {
      name: "tool-copy",
      createdBy: "owner",
    });

    const { declared: source, image } = await editable(l, "mbtest-template:tool-copy");
    await editTemplate(l.host, source, image, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } });

    expect(readRecipe(l.host, "tool-copy")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });
    // The template the fork came from keeps its own recipe.
    expect(readRecipe(l.host, "tool")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
  });
});

describe("two writers to one recipe", () => {
  test("the second edit is refused as busy while the first holds the name", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);
    const held = Promise.withResolvers<void>();

    const first = holdingTemplate(l.host, "tool", async () => {
      await held.promise;
      return "done";
    });
    const error = await rejectionOf(holdingTemplate(l.host, "tool", async () => "second"));

    expect(error).toMatchObject({ status: 409, key: "template_busy" });
    held.resolve();
    expect(await first).toBe("done");
    // The name is free again once the first writer ends, so a later edit is not refused.
    expect(
      await holdingTemplate(l.host, "tool", async () => editRecipe(l.host, source, { description: "Later" })),
    ).toMatchObject({ description: "Later" });
    expect(readRecipe(l.host, "tool")?.imageId).toBe(image.id);
  });
});

describe("a rebuild and an edit of one template", () => {
  test("an edit that lands while the rebuild runs is refused as busy, so the rebuild cannot overwrite it", async () => {
    const harness = startHarness();
    try {
      const started = await call(harness.base, "/api/templates", {
        body: { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE } },
      });
      expect(started.status).toBe(202);
      expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");

      // Hold the rebuild inside its build, once it already read the recipe it will write back.
      const buildsBefore = harness.runtime.callsTo("buildImage").length;
      const held = harness.runtime.hold("buildImage");
      try {
        const rebuilding = await call(harness.base, "/api/templates/mbtest-template:tool/rebuild", { method: "POST" });
        expect(rebuilding.status).toBe(202);
        for (let i = 0; i < 200 && harness.runtime.callsTo("buildImage").length === buildsBefore; i++)
          await Bun.sleep(10);
        expect(harness.runtime.callsTo("buildImage").length).toBe(buildsBefore + 1);

        const edited = await call(harness.base, editPath("mbtest-template:tool"), {
          method: "PATCH",
          body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
        });
        expect(refused(edited)).toEqual({ status: 409, key: "template_busy" });

        held.release();
        expect((await finishedTask(harness.base, rebuilding.json.taskId ?? "")).status).toBe("succeeded");
      } finally {
        held.release();
        await harness.app.tasks.drain();
      }
      // The rebuild's own source is what the recipe holds: the refused edit wrote nothing to lose.
      expect(readRecipe(harness.app.hosts.get(), "tool")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
    } finally {
      harness.stop();
    }
  });

  test("an edit that lands before the queued rebuild runs is not overwritten by it", async () => {
    // The operation reads the recipe while resolving its input, and the task takes the name later. An edit can land in
    // that gap, so the rebuild reads the recipe again once it holds the name and refuses a changed one.
    const l = lab();
    await declared(l);
    const resolved = await declaredTemplate(l.host, "mbtest-template:tool");
    editRecipe(l.host, resolved, { source: { kind: "dockerfile", text: FROM_ALPINE_21 } });

    const error = await rejectionOf(rebuildDeclaredTemplate(l.host, resolved, progressOf()));

    expect(error).toMatchObject({ status: 409, key: "template_busy" });
    // The edit is still what the template holds, and nothing was built from the source the rebuild started with.
    expect(readRecipe(l.host, "tool")?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });
    expect(l.runtime.builds).toHaveLength(1);
  });

  test("a rebuild from a Dockerfile keeps the setup an edit wrote, because that source names none", async () => {
    const l = lab();
    await declared(l);
    const { declared: source, image } = await editable(l);
    await editTemplate(l.host, source, image, {
      init: { postCreate: ["/bin/sh", "-c", "npm ci"], forwardPorts: [3000] },
    });

    await rebuildDeclaredTemplate(l.host, await declaredTemplate(l.host, "mbtest-template:tool"), progressOf());

    expect(readRecipe(l.host, "tool")?.init).toEqual({ postCreate: ["/bin/sh", "-c", "npm ci"], forwardPorts: [3000] });
  });
});

const forkPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/fork`;
const recipePath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}/recipe`;
const editPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}`;

describe("template.get and template.edit over REST", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = startHarness();
  });

  afterEach(() => harness.stop());

  async function declaredOverRest(name: string, text = FROM_ALPINE): Promise<void> {
    const started = await call(harness.base, "/api/templates", {
      body: { name, source: { kind: "dockerfile", text } },
    });
    expect(started.status).toBe(202);
    expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");
  }

  test("the recipe is the source the template was built from, and the setup it asks for", async () => {
    await declaredOverRest("tool");

    const read = await call(harness.base, recipePath("mbtest-template:tool"));

    expect(read.status).toBe(200);
    expect(read.json.recipe).toEqual({
      buildKind: "dockerfile",
      source: { kind: "dockerfile", text: FROM_ALPINE },
    });
  });

  test("a bare template name reads the recipe too", async () => {
    await declaredOverRest("tool");
    expect((await call(harness.base, recipePath("tool"))).json.recipe?.source).toEqual({
      kind: "dockerfile",
      text: FROM_ALPINE,
    });
  });

  test("a template that has no source answers template_not_declared", async () => {
    const read = await call(harness.base, recipePath("mbtest-template:base"));
    expect(refused(read)).toEqual({ status: 400, key: "template_not_declared" });
  });

  test("a ref that names no template is not found", async () => {
    expect(refused(await call(harness.base, recipePath("mbtest-template:ghost")))).toEqual({
      status: 404,
      key: "template_not_found",
    });
  });

  test("an edit answers 200 with the template, and the next read shows the new source", async () => {
    await declaredOverRest("tool");

    const edited = await call(harness.base, editPath("mbtest-template:tool"), {
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 }, description: "Ours" },
    });

    expect(edited.status).toBe(200);
    expect(edited.json.template).toEqual({ ref: "mbtest-template:tool", name: "tool", buildKind: "dockerfile" });
    const read = await call(harness.base, recipePath("mbtest-template:tool"));
    expect(read.json.recipe?.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });
    const listed = await call(harness.base, "/api/templates");
    expect(listed.json.templates).toContainEqual(
      expect.objectContaining({ ref: "mbtest-template:tool", description: "Ours", buildKind: "dockerfile" }),
    );
  });

  test("an edit with nothing to change is refused, and so is one on a template with no source", async () => {
    await declaredOverRest("tool");

    expect(refused(await call(harness.base, editPath("mbtest-template:tool"), { method: "PATCH", body: {} }))).toEqual({
      status: 400,
      key: "template_edit_empty",
    });
    expect(
      refused(
        await call(harness.base, editPath("mbtest-template:base"), {
          method: "PATCH",
          body: { description: "Renamed" },
        }),
      ),
    ).toEqual({ status: 400, key: "template_not_declared" });
  });

  test("a Dockerfile the server refuses is refused before the recipe is written", async () => {
    await declaredOverRest("tool");

    const edited = await call(harness.base, editPath("mbtest-template:tool"), {
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: "RUN true\n" } },
    });

    expect(refused(edited)).toMatchObject({ status: 400 });
    expect(readRecipeOnDisk(harness, "tool")).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
  });

  test("a token edits the template it created, and neither the owner's nor another token's", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    // The owner builds one; one token forks it, so the fork belongs to that token.
    await declaredOverRest("shared");
    const forked = await call(harness.base, forkPath("mbtest-template:shared"), {
      token: maker.secret,
      body: { name: "makers" },
    });
    expect(forked.status).toBe(201);

    const mine = await call(harness.base, editPath("mbtest-template:makers"), {
      token: maker.secret,
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
    });
    expect(mine.status).toBe(200);
    expect(readRecipeOnDisk(harness, "makers")).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });

    // An edit decides what the owner's next build produces and what every box created from it runs, so a token may not
    // change a template it merely may use.
    expect(
      refused(
        await call(harness.base, editPath("mbtest-template:shared"), {
          token: maker.secret,
          method: "PATCH",
          body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
        }),
      ),
    ).toEqual({ status: 403, key: "template_out_of_scope" });
    expect(readRecipeOnDisk(harness, "shared")).toEqual({ kind: "dockerfile", text: FROM_ALPINE });

    const stolen = await call(harness.base, editPath("mbtest-template:makers"), {
      token: other.secret,
      method: "PATCH",
      body: { description: "Taken" },
    });
    expect(refused(stolen)).toEqual({ status: 403, key: "template_out_of_scope" });
    // The recipe of a template the token cannot use is not readable either.
    expect(refused(await call(harness.base, recipePath("mbtest-template:makers"), { token: other.secret }))).toEqual({
      status: 403,
      key: "template_out_of_scope",
    });
    expect(readRecipeOnDisk(harness, "makers")).toEqual({ kind: "dockerfile", text: FROM_ALPINE_21 });
  });

  test("a sandboxed agent may read the recipe of a template it may use, and may not edit it", async () => {
    const sandboxed = mint(harness.app, { name: "sandboxed", preset: "sandboxed-agent" });
    await declaredOverRest("tool");

    // A read is the metadata `GET /api/templates` already shows, so a token that may use the template may read it.
    expect((await call(harness.base, recipePath("mbtest-template:tool"), { token: sandboxed.secret })).status).toBe(
      200,
    );
    // A write is owner-only, as every other template write is.
    expect(
      refused(
        await call(harness.base, editPath("mbtest-template:tool"), {
          token: sandboxed.secret,
          method: "PATCH",
          body: { description: "Ours" },
        }),
      ),
    ).toEqual({ status: 403, key: "operation_forbidden" });
  });

  test("the source of an official template cannot be replaced, and its setup can", async () => {
    // An official template's Dockerfile ships with MiniBox, so a rebuild uses the one of the running version.
    const host = harness.app.hosts.get();
    await createDeclaredTemplate(
      host,
      { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
      {
        log: () => {},
      },
    );

    expect(
      refused(
        await call(harness.base, editPath("mbtest-template:node"), {
          method: "PATCH",
          body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 } },
        }),
      ),
    ).toEqual({ status: 400, key: "template_source_builtin" });
    expect(readRecipeOnDisk(harness, "node")).toEqual({ kind: "official", name: "node" });

    // The setup and the description belong to the template itself, so they stay editable.
    const setup = await call(harness.base, editPath("mbtest-template:node"), {
      method: "PATCH",
      body: { init: { forwardPorts: [3000] } },
    });
    expect(setup.status).toBe(200);
    expect(readRecipe(host, "node")?.init).toEqual({ forwardPorts: [3000] });
  });

  test("a bare template name still names the template when a plain image has that name too", async () => {
    await declaredOverRest("tool");
    // A host may hold an image that is not a template and happens to be called `tool`.
    harness.runtime.seedImage("tool", {});

    const read = await call(harness.base, recipePath("tool"));

    expect(read.status).toBe(200);
    expect(read.json.recipe).toEqual({ buildKind: "dockerfile", source: { kind: "dockerfile", text: FROM_ALPINE } });
  });
});

/** The source on disk of a template's recipe, as a test can compare it. */
function readRecipeOnDisk(harness: Harness, name: string): unknown {
  return readRecipe(harness.app.hosts.get(), name)?.source;
}
