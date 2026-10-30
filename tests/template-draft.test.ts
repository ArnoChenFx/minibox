import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HostCtx } from "../src/host/registry";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { draftTemplate, readRecipe } from "../src/services/template-builds";
import { heldImage } from "../src/services/template-sync";
import {
  assertTemplateNameAvailable,
  deleteTemplate,
  listTemplateDrafts,
  promoteSnapshot,
  saveBoxAsTemplate,
} from "../src/services/templates";
import { rejectionOf, silenceLogs } from "./support/app";
import { bootCluster, type Cluster } from "./support/cluster";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";
const FROM_ALPINE_21 = "FROM alpine:3.21\nRUN true\n";

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

const draftPath = (ref: string) => `/api/templates/${encodeURIComponent(ref)}`;
const namePath = (name: string) => `/api/templates/${encodeURIComponent(`mbtest-template:${name}`)}`;
const DRAFTS = "/api/templates/drafts";

function recipeFile(host: HostCtx, name: string): string {
  return join(dirname(host.specs.dir()), "template-recipes", host.host.id, `${name}.json`);
}

describe("saving a template without building it", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = startHarness();
  });

  afterEach(() => harness.stop());

  async function save(name = "tool", description?: string) {
    return await call(harness.base, DRAFTS, {
      body: { name, description, source: { kind: "dockerfile", text: FROM_ALPINE } },
    });
  }

  async function build(name: string, text = FROM_ALPINE): Promise<void> {
    const started = await call(harness.base, "/api/templates", {
      body: { name, source: { kind: "dockerfile", text } },
    });
    expect(started.status).toBe(202);
    expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");
  }

  test("the save writes the recipe alone, lists it apart from the templates, and calls no engine", async () => {
    const saved = await save("tool", "Saved for later");

    expect(saved.status).toBe(201);
    expect(saved.json.template).toEqual({ ref: "mbtest-template:tool", name: "tool" });
    // Nothing was pulled, cloned or built: a draft is a recipe file and nothing else.
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(0);
    expect(harness.runtime.callsTo("pullImage")).toHaveLength(0);
    expect(harness.runtime.callsTo("createVolume")).toHaveLength(0);
    expect(harness.runtime.callsTo("createContainer")).toHaveLength(0);

    const host = harness.app.hosts.get();
    expect(readRecipe(host, "tool")).toMatchObject({
      version: 1,
      imageId: null,
      draft: true,
      description: "Saved for later",
      createdBy: "owner",
      source: { kind: "dockerfile", text: FROM_ALPINE },
    });
    expect(draftTemplate(host, "tool")).not.toBeNull();

    const drafts = await call(harness.base, DRAFTS);
    expect(drafts.status).toBe(200);
    // The draft list carries the source kind and the host that saved it, which the template list cannot: no image.
    const rows = drafts.json.templates as unknown as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        name: "tool",
        ref: "mbtest-template:tool",
        description: "Saved for later",
        buildKind: "dockerfile",
        hostId: host.host.id,
      },
    ]);
    // A draft is not a template yet: the template list, which lists images, does not show it.
    const listed = await call(harness.base, "/api/templates");
    expect((listed.json.templates ?? []).map((template) => template.ref)).not.toContain("mbtest-template:tool");
  });

  test("a name an image or a draft holds is refused by a save, a build, a fork, a box save and a promotion", async () => {
    expect((await save("tool")).status).toBe(201);
    expect(refused(await save("tool"))).toEqual({ status: 409, key: "template_name_taken" });
    expect(
      refused(
        await call(harness.base, "/api/templates", {
          body: { name: "tool", source: { kind: "dockerfile", text: FROM_ALPINE } },
        }),
      ),
    ).toEqual({ status: 409, key: "template_name_taken" });
    expect(
      refused(await call(harness.base, draftPath("mbtest-template:base") + "/fork", { body: { name: "tool" } })),
    ).toEqual({ status: 409, key: "template_name_taken" });

    // A build under the draft's name is refused too: the draft keeps the name it will be built under.
    const host = harness.app.hosts.get();
    const box = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256 });
    expect(await rejectionOf(saveBoxAsTemplate(host, box.boxId, { name: "tool" }, "owner"))).toMatchObject({
      status: 409,
      key: "template_name_taken",
    });
    expect(await rejectionOf(promoteSnapshot(host, "mbtest-template:any", "tool"))).toMatchObject({
      status: 409,
      key: "template_name_taken",
    });
    // The draft is untouched by every refusal.
    expect(draftTemplate(host, "tool")?.recipe.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
  });

  test("a name an image already holds is refused for a draft", async () => {
    await build("built");

    expect(refused(await save("built"))).toEqual({ status: 409, key: "template_name_taken" });
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(1);
  });

  test("an edit changes the draft's recipe only, and a build then makes it a normal template", async () => {
    await save("tool", "Saved for later");

    const edited = await call(harness.base, draftPath("mbtest-template:tool"), {
      method: "PATCH",
      body: { source: { kind: "dockerfile", text: FROM_ALPINE_21 }, init: { forwardPorts: [8080] } },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.template).toEqual({
      ref: "mbtest-template:tool",
      name: "tool",
      buildKind: "dockerfile",
    });
    // An edit writes the recipe and nothing else: no image exists to re-commit.
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(0);
    expect(harness.runtime.callsTo("commitContainer")).toHaveLength(0);
    const host = harness.app.hosts.get();
    expect(readRecipe(host, "tool")).toMatchObject({
      draft: true,
      imageId: null,
      source: { kind: "dockerfile", text: FROM_ALPINE_21 },
      init: { forwardPorts: [8080] },
    });
    expect((await call(harness.base, draftPath("mbtest-template:tool") + "/recipe")).json.recipe).toMatchObject({
      buildKind: "dockerfile",
      source: { kind: "dockerfile", text: FROM_ALPINE_21 },
      forwardPorts: [8080],
    });

    const rebuilding = await call(harness.base, draftPath("mbtest-template:tool") + "/rebuild", { method: "POST" });
    expect(rebuilding.status).toBe(202);
    expect((await finishedTask(harness.base, rebuilding.json.taskId ?? "")).status).toBe("succeeded");

    // The build makes the name a template: the image is listed, the draft is gone, and the saved fields survived.
    const listed = await call(harness.base, "/api/templates");
    expect(listed.json.templates).toContainEqual(
      expect.objectContaining({
        ref: "mbtest-template:tool",
        description: "Saved for later",
        buildKind: "dockerfile",
        forwardPorts: [8080],
      }),
    );
    expect((await call(harness.base, DRAFTS)).json.templates).toEqual([]);
    const image = await harness.runtime.inspectImage("mbtest-template:tool");
    expect(readRecipe(host, "tool")).toMatchObject({
      imageId: image.id,
      description: "Saved for later",
      createdBy: "owner",
      source: { kind: "dockerfile", text: FROM_ALPINE_21 },
      init: { forwardPorts: [8080] },
    });
    expect(readRecipe(host, "tool")?.draft).toBeUndefined();
    expect(listTemplateDrafts(host)).toEqual([]);
  });

  test("a failed first build keeps the draft, with exactly the source it saved", async () => {
    await save("tool", "Saved for later");
    const host = harness.app.hosts.get();
    const before = readFileSync(recipeFile(host, "tool"), "utf8");
    harness.runtime.fail("buildImage", new RuntimeError("engine", "no space left on device"));

    const rebuilding = await call(harness.base, draftPath("mbtest-template:tool") + "/rebuild", { method: "POST" });
    expect(rebuilding.status).toBe(202);
    expect((await finishedTask(harness.base, rebuilding.json.taskId ?? "")).status).toBe("failed");

    // The draft is still there, unchanged, so the saved configuration is never lost to a failed build.
    expect(readFileSync(recipeFile(host, "tool"), "utf8")).toBe(before);
    expect(draftTemplate(host, "tool")?.recipe.source).toEqual({ kind: "dockerfile", text: FROM_ALPINE });
    expect((await call(harness.base, DRAFTS)).json.templates).toHaveLength(1);
    expect(listTemplateDrafts(host)).toHaveLength(1);
    expect(((await call(harness.base, "/api/templates")).json.templates ?? []).map((t) => t.ref)).not.toContain(
      "mbtest-template:tool",
    );
  });

  test("deleting a draft removes its recipe and touches no image", async () => {
    await save("tool");
    const host = harness.app.hosts.get();

    const deleted = await call(harness.base, `${draftPath("mbtest-template:tool")}?host=${host.host.id}`, {
      method: "DELETE",
    });

    expect(deleted.status).toBe(200);
    expect(deleted.json).toEqual({ ok: true });
    expect(readRecipe(host, "tool")).toBeNull();
    expect((await call(harness.base, DRAFTS)).json.templates).toEqual([]);
    expect(harness.runtime.callsTo("removeImage")).toHaveLength(0);
    // The name is free again, so it can be saved or built.
    expect((await save("tool")).status).toBe(201);
  });

  test("a box created from a draft is refused with a message that says it is not built", async () => {
    await save("tool");

    const created = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", template: "mbtest-template:tool", cpus: 1, memoryMb: 256 },
    });

    expect(refused(created)).toEqual({ status: 400, key: "template_not_built" });
    expect(created.json.error?.details?.field).toBe("template");
    expect(created.json.error?.message).toContain("not built yet");
    // A bare name names the draft too, and no image was pulled for either attempt.
    expect(refused(await call(harness.base, "/api/boxes", { body: { name: "beta", template: "tool" } }))).toEqual({
      status: 400,
      key: "template_not_built",
    });
    expect(harness.runtime.callsTo("pullImage")).toHaveLength(0);
    expect(harness.app.hosts.get().specs.findByName("alpha")).toBeNull();
  });

  test("a delete by bare name removes a draft too", async () => {
    await save("tool");
    const host = harness.app.hosts.get();

    await deleteTemplate(host, "tool");

    expect(draftTemplate(host, "tool")).toBeNull();
    expect(harness.runtime.callsTo("removeImage")).toHaveLength(0);
  });

  test("a name a draft holds is unavailable, and free once the draft is gone", async () => {
    await save("tool");
    const host = harness.app.hosts.get();

    expect(await rejectionOf(assertTemplateNameAvailable(host, "tool"))).toMatchObject({
      status: 409,
      key: "template_name_taken",
    });
    await deleteTemplate(host, "mbtest-template:tool");
    expect(await assertTemplateNameAvailable(host, "tool")).toBeUndefined();
  });

  test("a draft cannot take a name MiniBox builds a template under itself", async () => {
    const host = harness.app.hosts.get();

    for (const name of ["base", "node"]) {
      const saved = await call(harness.base, DRAFTS, {
        body: { name, source: { kind: "dockerfile", text: FROM_ALPINE } },
      });
      expect([name, refused(saved)]).toEqual([name, { status: 409, key: "template_name_reserved" }]);
      // Nothing was written: the name is still the one the built-in build uses.
      expect([name, draftTemplate(host, name)]).toEqual([name, null]);
    }
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(0);
  });

  test("deleting a draft while it is being built is refused as busy, and the build still ends as a template", async () => {
    await save("tool");
    const host = harness.app.hosts.get();
    const buildsBefore = harness.runtime.callsTo("buildImage").length;
    const held = harness.runtime.hold("buildImage");
    try {
      const rebuilding = await call(harness.base, `${draftPath("mbtest-template:tool")}/rebuild`, {
        method: "POST",
      });
      expect(rebuilding.status).toBe(202);
      // Once buildImage is reached, the rebuild already holds the name, so the delete below must be refused.
      for (let i = 0; i < 200 && harness.runtime.callsTo("buildImage").length === buildsBefore; i++)
        await Bun.sleep(10);
      expect(harness.runtime.callsTo("buildImage")).toHaveLength(buildsBefore + 1);

      expect(
        refused(
          await call(harness.base, `${draftPath("mbtest-template:tool")}?host=${host.host.id}`, { method: "DELETE" }),
        ),
      ).toEqual({ status: 409, key: "template_busy" });
      expect(draftTemplate(host, "tool")).not.toBeNull();

      held.release();
      expect((await finishedTask(harness.base, rebuilding.json.taskId ?? "")).status).toBe("succeeded");
    } finally {
      held.release();
      await harness.app.tasks.drain();
    }
    // The build was not interrupted by the refused delete, so the draft became the template it was building.
    expect(draftTemplate(host, "tool")).toBeNull();
    expect(((await call(harness.base, "/api/templates")).json.templates ?? []).map((t) => t.ref)).toContain(
      "mbtest-template:tool",
    );
  });

  test("a token that creates a box from a draft learns nothing more than from a name it cannot use", async () => {
    await save("tool");
    const token = mint(harness.app, { name: "operator", preset: "operator" });

    const draft = await call(harness.base, "/api/boxes", {
      token: token.secret,
      body: { name: "alpha", template: "mbtest-template:tool", cpus: 1, memoryMb: 256 },
    });
    const missing = await call(harness.base, "/api/boxes", {
      token: token.secret,
      body: { name: "beta", template: "mbtest-template:ghost", cpus: 1, memoryMb: 256 },
    });

    expect(refused(draft)).toEqual({ status: 403, key: "template_out_of_scope" });
    expect(refused(draft)).toEqual(refused(missing));
  });
});

describe("a draft and a built template under one name on different hosts", () => {
  let cluster: Cluster;

  beforeEach(async () => {
    cluster = await bootCluster();
  });

  afterEach(() => cluster.close());

  async function built(name: string): Promise<void> {
    const started = await cluster.post("/api/templates", {
      name,
      source: { kind: "dockerfile", text: FROM_ALPINE },
    });
    expect(started.status).toBe(202);
    const { taskId } = (await started.json()) as { taskId: string };
    expect((await finishedTask(cluster.base, taskId)).status).toBe("succeeded");
  }

  async function draftOn(host: string, name: string): Promise<void> {
    const saved = await cluster.post("/api/templates/drafts", {
      name,
      host,
      source: { kind: "dockerfile", text: FROM_ALPINE_21 },
    });
    expect(saved.status).toBe(201);
  }

  test("without a host, a read and a delete name the built image, not the draft elsewhere", async () => {
    await built("shared");
    await draftOn("small", "shared");

    const read = await cluster.api(`${namePath("shared")}/recipe`);
    expect(read.status).toBe(200);
    const recipe = (await read.json()) as { recipe: { source: { text: string } } };
    expect(recipe.recipe.source.text).toBe(FROM_ALPINE);
    // The read left the draft alone, and the built image is what the delete below removes.
    expect(draftTemplate(cluster.app.hosts.get("small"), "shared")).not.toBeNull();
    expect((await cluster.api(namePath("shared"), { method: "DELETE" })).status).toBe(200);
    expect(await heldImage(cluster.app.hosts.get("local"), "mbtest-template:shared")).toBeNull();
    expect(draftTemplate(cluster.app.hosts.get("small"), "shared")).not.toBeNull();

    // With the host named, the draft is what is read and what the delete removes.
    const byHost = await cluster.api(`${namePath("shared")}/recipe?host=small`);
    expect(byHost.status).toBe(200);
    expect(((await byHost.json()) as { recipe: { source: { text: string } } }).recipe.source.text).toBe(FROM_ALPINE_21);
    expect((await cluster.api(`${namePath("shared")}?host=small`, { method: "DELETE" })).status).toBe(200);
    expect(draftTemplate(cluster.app.hosts.get("small"), "shared")).toBeNull();
  });

  test("a copy to a host that holds a draft of the name is refused before any image is sent", async () => {
    await built("shared");
    await draftOn("small", "shared");

    const synced = await cluster.post(`/api/templates/${encodeURIComponent("mbtest-template:shared")}/sync`, {
      host: "small",
    });
    expect(synced.status).toBe(202);
    const { taskId } = (await synced.json()) as { taskId: string };
    const task = await finishedTask(cluster.base, taskId);
    expect(task.status).toBe("failed");
    expect(task.error?.key).toBe("template_name_taken");
    // The refusal came before the transfer, so the target has neither the image nor a replaced draft.
    expect(await heldImage(cluster.app.hosts.get("small"), "mbtest-template:shared")).toBeNull();
    expect(draftTemplate(cluster.app.hosts.get("small"), "shared")?.recipe.source).toEqual({
      kind: "dockerfile",
      text: FROM_ALPINE_21,
    });
  });
});
