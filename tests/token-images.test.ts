import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { silenceLogs } from "./support/app";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

let harness: Harness;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

async function createBox(token: string, name: string, extra: Record<string, unknown> = {}) {
  return call(harness.base, "/api/boxes", {
    token,
    body: { name, cpus: 1, memoryMb: 256, ...extra },
  });
}

describe("templates a token may build from", () => {
  test("an operator with created-by-me gets build guidance for a missing default, then creates with the same token once it is built", async () => {
    const host = harness.app.hosts.get();
    await harness.runtime.removeImage(host.baseTemplateTag, { force: true });
    const issued = await call(harness.base, "/api/tokens", {
      body: { name: "operator", preset: "operator", boxes: "created-by-me" },
    });
    expect(issued.status).toBe(201);
    const token = issued.json.token ?? "";
    for (const extra of [{}, { template: host.baseTemplateTag }]) {
      const missing = await createBox(token, "first", extra);
      expect(refused(missing)).toEqual({ status: 400, key: "template_image_missing" });
      expect(missing.json.error?.details).toEqual({ field: "template" });
      expect(missing.json.error?.message).toContain(host.baseTemplateTag);
    }
    expect(harness.runtime.callsTo("createContainer")).toHaveLength(0);
    expect(harness.runtime.callsTo("createVolume")).toHaveLength(0);
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(0);
    expect(harness.app.hosts.get().specs.list()).toHaveLength(0);
    const build = await call(harness.base, "/api/templates/base/build", { body: {} });
    expect(build.status).toBe(202);
    expect((await finishedTask(harness.base, build.json.taskId ?? "")).status).toBe("succeeded");
    const created = await createBox(token, "first");
    expect(created.status).toBe(201);
    expect(created.json.box?.createdBy).toBe(issued.json.record?.id);
    expect((await call(harness.base, `/api/boxes/${created.json.box?.boxId}`, { token })).status).toBe(200);
  });

  test("an operator can choose another built template while the default is missing", async () => {
    const host = harness.app.hosts.get();
    await harness.runtime.removeImage(host.baseTemplateTag, { force: true });
    const agent = mint(harness.app, { name: "operator", preset: "operator" });
    harness.runtime.seedImage("mbtest-template:other", {
      [host.keys.template]: "true",
      [host.keys.templateName]: "other",
      [host.keys.createdBy]: "owner",
    });
    const created = await createBox(agent.secret, "other", { template: "mbtest-template:other" });
    expect(created.status).toBe(201);
    expect(created.json.box?.createdBy).toBe(agent.id);
    expect(harness.runtime.callsTo("buildImage")).toHaveLength(0);
  });

  test("a default tag belonging to another token remains forbidden, even though a missing default has build guidance", async () => {
    const host = harness.app.hosts.get();
    const agent = mint(harness.app, { name: "operator", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    harness.runtime.moveTag(host.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
      [host.keys.createdBy]: other.id,
    });
    expect(refused(await createBox(agent.secret, "refused"))).toEqual({ status: 403, key: "template_out_of_scope" });
    expect(harness.runtime.callsTo("createContainer")).toHaveLength(0);
  });

  test("a token creates from an owner template or its own, and not from another token's, by name or by image id", async () => {
    const keys = harness.app.hosts.get().keys;
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    harness.runtime.seedImage("mbtest-template:shared", { [keys.template]: "true", [keys.templateName]: "shared" });
    const imageId = harness.runtime.seedImage("mbtest-template:mine", {
      [keys.template]: "true",
      [keys.templateName]: "mine",
      [keys.createdBy]: maker.id,
    });

    expect(refused(await createBox(maker.secret, "own", { template: "mbtest-template:mine" })).status).toBe(201);
    expect(refused(await createBox(other.secret, "shared", { template: "mbtest-template:shared" })).status).toBe(201);
    expect(refused(await createBox(other.secret, "by-name", { template: "mbtest-template:mine" }))).toEqual({
      status: 403,
      key: "template_out_of_scope",
    });
    expect(refused(await createBox(other.secret, "by-id", { template: imageId }))).toEqual({
      status: 403,
      key: "template_out_of_scope",
    });
    expect(refused(await createBox(other.secret, "missing", { template: "mbtest-template:nothing" }))).toEqual({
      status: 403,
      key: "template_out_of_scope",
    });
  });

  test("a template list shows a token the owner's templates and its own, and no other token's", async () => {
    const keys = harness.app.hosts.get().keys;
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    harness.runtime.seedImage("mbtest-template:shared", { [keys.template]: "true", [keys.templateName]: "shared" });
    harness.runtime.seedImage("mbtest-template:mine", {
      [keys.template]: "true",
      [keys.templateName]: "mine",
      [keys.createdBy]: maker.id,
    });

    const seen = await call(harness.base, "/api/templates", { token: other.secret });
    const names = (seen.json.templates ?? []).map((image) => image.name);
    expect(names).toContain("shared");
    expect(names).not.toContain("mine");
    const own = await call(harness.base, "/api/templates", { token: maker.secret });
    expect((own.json.templates ?? []).map((image) => image.name)).toContain("mine");
  });

  test("a rebuild that a moved tag would take onto another token's template is refused", async () => {
    const keys = harness.app.hosts.get().keys;
    const tracker = mint(harness.app, { name: "tracker", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    harness.runtime.seedImage("mbtest-template:tracked", {
      [keys.template]: "true",
      [keys.templateName]: "tracked",
      [keys.createdBy]: tracker.id,
    });
    const made = await createBox(tracker.secret, "tracked-box", { template: "mbtest-template:tracked" });
    expect(made.status).toBe(201);
    const boxId = made.json.box?.id ?? "";

    const before = await call(harness.base, `/api/boxes/${boxId}/rebuild`, {
      token: tracker.secret,
      body: { profile: "strict" },
      headers: { "if-match": "1" },
    });
    expect(before.status).toBe(409);

    harness.runtime.moveTag("mbtest-template:tracked", {
      [keys.template]: "true",
      [keys.templateName]: "tracked",
      [keys.createdBy]: other.id,
    });
    const after = await call(harness.base, `/api/boxes/${boxId}/rebuild`, {
      token: tracker.secret,
      body: { confirm: true },
      headers: { "if-match": "1" },
    });
    expect(refused(after)).toEqual({ status: 403, key: "template_out_of_scope" });
    const owner = await call(harness.base, `/api/boxes/${boxId}`);
    expect(owner.json.box?.revision).toBe(1);
  });

  test("the owner's template build is owner-only, even for a token that holds every scope", async () => {
    const admin = mint(harness.app, { name: "root", preset: "admin" });
    const built = await call(harness.base, "/api/templates/base/build", { token: admin.secret, method: "POST" });
    expect(refused(built)).toEqual({ status: 403, key: "operation_forbidden" });
  });
});

describe("promotion and deletion of templates", () => {
  test("a token promotes only its own snapshot, under a name no template holds, and deletes only what it made", async () => {
    const snapper = mint(harness.app, { name: "snapper", preset: "operator" });
    const rival = mint(harness.app, { name: "rival", preset: "operator" });
    const keys = harness.app.hosts.get().keys;
    harness.runtime.seedImage("mbtest-template:shared", { [keys.template]: "true", [keys.templateName]: "shared" });

    const box = await createBox(snapper.secret, "source");
    const boxId = box.json.box?.id ?? "";
    const taken = await call(harness.base, `/api/boxes/${boxId}/snapshots`, {
      token: snapper.secret,
      body: { name: "nightly" },
    });
    expect(taken.status).toBe(202);
    const ref = (await finishedTask(harness.base, taken.json.taskId ?? "")).result?.snapshot?.ref ?? "";
    expect(ref).not.toBe("");

    const stolen = await call(harness.base, `/api/snapshots/${encodeURIComponent(ref)}/promote`, {
      token: rival.secret,
      body: { name: "stolen" },
    });
    expect(refused(stolen)).toEqual({ status: 403, key: "snapshot_out_of_scope" });

    const promoted = await call(harness.base, `/api/snapshots/${encodeURIComponent(ref)}/promote`, {
      token: snapper.secret,
      body: { name: "mine" },
    });
    expect(promoted.status).toBe(201);
    const again = await call(harness.base, `/api/snapshots/${encodeURIComponent(ref)}/promote`, {
      token: snapper.secret,
      body: { name: "mine" },
    });
    expect(refused(again)).toEqual({ status: 403, key: "template_out_of_scope" });

    const listed = await call(harness.base, "/api/templates", { token: rival.secret });
    expect((listed.json.templates ?? []).map((image) => image.name)).not.toContain("mine");

    const rivalDelete = await call(harness.base, "/api/templates/mbtest-template%3Amine", {
      token: rival.secret,
      method: "DELETE",
    });
    expect(refused(rivalDelete)).toEqual({ status: 403, key: "template_out_of_scope" });
    const ownerTemplate = await call(harness.base, "/api/templates/mbtest-template%3Ashared", {
      token: snapper.secret,
      method: "DELETE",
    });
    expect(refused(ownerTemplate)).toEqual({ status: 403, key: "template_out_of_scope" });
    const own = await call(harness.base, "/api/templates/mbtest-template%3Amine", {
      token: snapper.secret,
      method: "DELETE",
    });
    expect(own.status).toBe(200);
  });
});

describe("snapshots a token may see", () => {
  test("a snapshot is listed and forked by a token that may see its source box, by stable id, and by its creator", async () => {
    const keys = harness.app.hosts.get().keys;
    const owned = await call(harness.base, "/api/boxes", { body: { name: "owned", cpus: 1, memoryMb: 256 } });
    const ownedId = owned.json.box?.boxId ?? "";
    const elsewhere = await call(harness.base, "/api/boxes", { body: { name: "elsewhere", cpus: 1, memoryMb: 256 } });
    const elsewhereId = elsewhere.json.box?.boxId ?? "";
    harness.runtime.seedImage("mbtest-snapshot:of-owned", {
      [keys.snapshot]: "true",
      [keys.snapshotOfId]: ownedId,
      [keys.createdBy]: "owner",
    });
    harness.runtime.seedImage("mbtest-snapshot:of-elsewhere", {
      [keys.snapshot]: "true",
      [keys.snapshotOfId]: elsewhereId,
      [keys.createdBy]: "owner",
    });
    const granted = mint(harness.app, { name: "granted", preset: "operator", boxes: { type: "ids", ids: [ownedId] } });
    const stranger = mint(harness.app, { name: "stranger", preset: "operator" });

    const seen = await call(harness.base, "/api/snapshots", { token: granted.secret });
    expect((seen.json.snapshots ?? []).map((image) => image.ref)).toEqual(["mbtest-snapshot:of-owned"]);
    const none = await call(harness.base, "/api/snapshots", { token: stranger.secret });
    expect(none.json.snapshots).toEqual([]);

    const forked = await call(harness.base, "/api/snapshots/mbtest-snapshot%3Aof-owned/boxes", {
      token: granted.secret,
      body: { name: "copy", cpus: 1, memoryMb: 256 },
    });
    expect(forked.status).toBe(201);
    const outOfScope = await call(harness.base, "/api/snapshots/mbtest-snapshot%3Aof-elsewhere/boxes", {
      token: granted.secret,
      body: { name: "copy-2", cpus: 1, memoryMb: 256 },
    });
    expect(refused(outOfScope)).toEqual({ status: 403, key: "snapshot_out_of_scope" });

    const creator = mint(harness.app, { name: "creator", preset: "operator" });
    harness.runtime.seedImage("mbtest-snapshot:made-by-creator", {
      [keys.snapshot]: "true",
      [keys.snapshotOfId]: "bx_gone0000000000000000000000",
      [keys.createdBy]: creator.id,
    });
    const own = await call(harness.base, "/api/snapshots", { token: creator.secret });
    expect((own.json.snapshots ?? []).map((image) => image.ref)).toEqual(["mbtest-snapshot:made-by-creator"]);
  });
});
