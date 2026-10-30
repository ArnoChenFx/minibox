import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { legacyCheckpointId } from "../src/checkpoints/id";
import type { HostMetrics } from "../src/host/metrics";
import type { AuditEvent } from "../src/operations/executor";
import { OWNER, type OperationContext } from "../src/operations/types";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import {
  type CheckpointBody,
  call,
  finishedTask,
  type Harness,
  mint,
  refused,
  type Reply,
  startHarness,
} from "./support/tokens";

const GB = 1024 ** 3;

/** A host with room for every request here, so the capacity check never decides an answer. */
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;

describe("checkpoints over HTTP", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = startHarness();
    harness.app.monitor.snapshot = async () => ROOMY_HOST;
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  /** A box made over REST by `token`, or by the owner when none is given. Returns its stable id. */
  async function makeBox(name: string, token?: string, extra: Record<string, unknown> = {}): Promise<string> {
    const reply = await call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256, ...extra } });
    expect(reply.status).toBe(201);
    return reply.json.box?.boxId ?? "";
  }

  /** Takes a checkpoint over REST and waits for its task, which returns the checkpoint. */
  async function take(boxId: string, token?: string, body: Record<string, unknown> = {}): Promise<CheckpointBody> {
    const started = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body, token });
    expect(started.status).toBe(202);
    const done = await finishedTask(harness.base, started.json.taskId ?? "");
    expect(done.status).toBe("succeeded");
    const checkpoint = done.result?.checkpoint;
    if (!checkpoint) throw new Error("the task returned no checkpoint");
    return checkpoint;
  }

  const settle = (reply: Reply) => finishedTask(harness.base, reply.json.taskId ?? "");

  const tasksCount = async (): Promise<number> => (await call(harness.base, "/api/tasks")).json.tasks?.length ?? -1;

  function engineAt(boxId: string, path: string): string {
    const mount = harness.app.hosts
      .get()
      .specs.read(boxId)
      ?.mounts.find((item) => item.path === path);
    if (!mount) throw new Error(`no mount at ${path}`);
    return mount.volume;
  }

  function seed(volume: string, path: string, text: string): void {
    harness.runtime.seedVolumeFile(volume, path, {
      type: "file",
      content: Buffer.from(text),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    });
  }

  function filesOf(volume: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, entry] of harness.runtime.filesOf(volume)) {
      if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
    }
    return out;
  }

  const imageTagged = (tag: string): boolean =>
    [...harness.runtime.images.values()].some((image) => image.tags.includes(tag));

  test("a take answers 202, and the checkpoint its task made is the one the list and the read show", async () => {
    const boxId = await makeBox("alpha");
    seed(engineAt(boxId, "/workspace"), "src/app.ts", "console.log(1)");

    const started = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
      method: "POST",
      body: { label: "before refactor", reason: "safe point" },
    });
    expect(started.status).toBe(202);
    const done = await settle(started);
    expect(done.status).toBe("succeeded");
    const checkpoint = done.result?.checkpoint;
    expect(checkpoint).toMatchObject({
      legacy: false,
      label: "before refactor",
      reason: "safe point",
      boxId,
      pinned: false,
      consistency: "live",
    });
    expect(checkpoint?.data.map((layer) => layer.path)).toEqual(["/workspace", "/home/dev"]);

    const id = checkpoint?.id ?? "";
    const listed = await call(harness.base, "/api/checkpoints");
    expect(listed.json.checkpoints?.map((item) => item.id)).toEqual([id]);
    const read = await call(harness.base, `/api/checkpoints/${id}`);
    expect(read.status).toBe(200);
    expect(read.json.checkpoint).toMatchObject({ id, label: "before refactor" });
  });

  test("a take with an unknown consistency mode is refused in the request, and starts no task", async () => {
    const boxId = await makeBox("alpha");

    const reply = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
      method: "POST",
      body: { consistency: "warm" },
    });

    expect(reply.status).toBe(400);
    expect(reply.json.error?.code).toBe("validation_failed");
    expect(await tasksCount()).toBe(0);
  });

  test("a rollback is refused before anything starts when the revision is missing or stale", async () => {
    const boxId = await makeBox("alpha");
    const id = (await take(boxId)).id;

    const missing = await call(harness.base, `/api/boxes/${boxId}/rollback`, {
      method: "POST",
      body: { checkpoint: id, confirm: true },
    });
    expect(refused(missing)).toEqual({ status: 428, key: "revision_required" });

    const stale = await call(harness.base, `/api/boxes/${boxId}/rollback`, {
      method: "POST",
      body: { checkpoint: id, confirm: true },
      headers: { "if-match": "7" },
    });
    expect(refused(stale)).toEqual({ status: 412, key: "revision_mismatch" });

    expect((await call(harness.base, `/api/boxes/${boxId}`)).json.box?.revision).toBe(1);
  });

  test("a rollback without confirm is a 409 preview, and it starts no task or changes the box", async () => {
    const boxId = await makeBox("alpha");
    const id = (await take(boxId)).id;
    const before = await tasksCount();

    const reply = await call(harness.base, `/api/boxes/${boxId}/rollback`, {
      method: "POST",
      body: { checkpoint: id },
      headers: { "if-match": "1" },
    });

    expect(reply.status).toBe(409);
    expect(reply.json.error?.code).toBe("confirmation_required");
    expect(reply.json.error?.details?.preview?.restores).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/workspace", role: "workspace" })]),
    );
    expect(await tasksCount()).toBe(before);
    expect((await call(harness.base, `/api/boxes/${boxId}`)).json.box?.revision).toBe(1);
  });

  test("a confirmed rollback answers 202, restores the file into a new volume, and keeps the replaced one", async () => {
    const boxId = await makeBox("alpha");
    const original = engineAt(boxId, "/workspace");
    seed(original, "kept.txt", "from the checkpoint");
    const id = (await take(boxId)).id;
    seed(original, "later.txt", "written after the checkpoint");

    const started = await call(harness.base, `/api/boxes/${boxId}/rollback`, {
      method: "POST",
      body: { checkpoint: id, confirm: true },
      headers: { "if-match": "1" },
    });

    expect(started.status).toBe(202);
    const done = await settle(started);
    expect(done.status).toBe("succeeded");
    expect(done.result?.box?.boxId).toBe(boxId);
    expect(done.result?.replaced).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "alpha-workspace" })]),
    );
    const restored = engineAt(boxId, "/workspace");
    expect(restored).not.toBe(original);
    expect(filesOf(restored)).toEqual({ "kept.txt": "from the checkpoint" });
    expect(harness.runtime.volumes.has(original)).toBe(true);
  });

  test("a fork answers 202 with a box that holds the checkpoint's files and not the source's later ones", async () => {
    const boxId = await makeBox("alpha");
    seed(engineAt(boxId, "/workspace"), "README.md", "hello");
    const id = (await take(boxId)).id;
    seed(engineAt(boxId, "/workspace"), "after.txt", "later");

    const started = await call(harness.base, `/api/checkpoints/${id}/fork`, {
      method: "POST",
      body: { name: "alpha-copy", cpus: 1, memoryMb: 256 },
    });

    expect(started.status).toBe(202);
    const done = await settle(started);
    expect(done.status).toBe("succeeded");
    expect(done.result?.box?.name).toBe("alpha-copy");
    const forked = done.result?.box?.boxId ?? "";
    expect(filesOf(engineAt(forked, "/workspace"))).toEqual({ "README.md": "hello" });
    expect(filesOf(engineAt(boxId, "/workspace"))).toMatchObject({ "after.txt": "later" });
  });

  test("a fork is refused before a task starts when its name is taken or its checkpoint does not exist", async () => {
    const boxId = await makeBox("alpha");
    const id = (await take(boxId)).id;

    const taken = await call(harness.base, `/api/checkpoints/${id}/fork`, {
      method: "POST",
      body: { name: "alpha", cpus: 1, memoryMb: 256 },
    });
    expect(refused(taken)).toEqual({ status: 409, key: "box_exists" });

    const missing = await call(harness.base, "/api/checkpoints/ck_0000000000000000000000000/fork", {
      method: "POST",
      body: { name: "ghost", cpus: 1, memoryMb: 256 },
    });
    expect(refused(missing)).toEqual({ status: 404, key: "checkpoint_not_found" });
  });

  test("a pinned checkpoint answers 409 to delete before a task starts, and unpinning lets it go", async () => {
    const boxId = await makeBox("alpha");
    const id = (await take(boxId)).id;

    const pinned = await call(harness.base, `/api/checkpoints/${id}`, {
      method: "PATCH",
      body: { pinned: true, label: "keep" },
    });
    expect(pinned.status).toBe(202);
    expect((await settle(pinned)).result?.checkpoint).toMatchObject({ pinned: true, label: "keep" });

    expect(refused(await call(harness.base, `/api/checkpoints/${id}`, { method: "DELETE" }))).toEqual({
      status: 409,
      key: "checkpoint_pinned",
    });

    const unpinned = await call(harness.base, `/api/checkpoints/${id}`, { method: "PATCH", body: { pinned: false } });
    expect((await settle(unpinned)).status).toBe("succeeded");
    const deleted = await call(harness.base, `/api/checkpoints/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(202);
    expect((await settle(deleted)).status).toBe("succeeded");
    expect(refused(await call(harness.base, `/api/checkpoints/${id}`))).toEqual({
      status: 404,
      key: "checkpoint_not_found",
    });
  });

  test("a legacy snapshot is listed under its derived id, forks and deletes, and refuses a change", async () => {
    const keys = harness.app.hosts.get().keys;
    const boxId = await makeBox("alpha");
    const imageId = harness.runtime.seedImage("mbtest-snap:alpha-snap-20261020-000000", {
      [keys.snapshot]: "true",
      [keys.snapshotOf]: "alpha",
      [keys.snapshotOfId]: boxId,
      [keys.templateName]: "alpha-snap",
      [keys.created]: "2026-10-20T00:00:00.000Z",
    });
    const id = legacyCheckpointId(imageId);

    const listed = await call(harness.base, "/api/checkpoints");
    expect(listed.json.checkpoints?.find((item) => item.id === id)).toMatchObject({ legacy: true, boxId, data: [] });
    expect(
      refused(await call(harness.base, `/api/checkpoints/${id}`, { method: "PATCH", body: { pinned: true } })),
    ).toEqual({ status: 409, key: "checkpoint_legacy_read_only" });

    const forked = await call(harness.base, `/api/checkpoints/${id}/fork`, {
      method: "POST",
      body: { name: "from-snap", cpus: 1, memoryMb: 256 },
    });
    expect((await settle(forked)).status).toBe("succeeded");

    const deleted = await call(harness.base, `/api/checkpoints/${id}`, { method: "DELETE" });
    expect((await settle(deleted)).status).toBe("succeeded");
    expect(imageTagged("mbtest-snap:alpha-snap-20261020-000000")).toBe(false);
  });

  test("a stranger sees no checkpoint of a box it cannot see, and each action on one is refused", async () => {
    const boxId = await makeBox("alpha");
    const id = (await take(boxId)).id;
    const stranger = mint(harness.app, { name: "stranger", preset: "operator" });

    expect((await call(harness.base, "/api/checkpoints", { token: stranger.secret })).json.checkpoints).toEqual([]);
    expect(refused(await call(harness.base, `/api/checkpoints/${id}`, { token: stranger.secret }))).toEqual({
      status: 403,
      key: "checkpoint_out_of_scope",
    });
    expect(
      refused(
        await call(harness.base, `/api/checkpoints/${id}/fork`, {
          token: stranger.secret,
          method: "POST",
          body: { name: "copy", cpus: 1, memoryMb: 256 },
        }),
      ),
    ).toEqual({ status: 403, key: "checkpoint_out_of_scope" });
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
          token: stranger.secret,
          method: "POST",
          body: {},
        }),
      ),
    ).toEqual({ status: 403, key: "box_out_of_scope" });
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/rollback`, {
          token: stranger.secret,
          method: "POST",
          body: { checkpoint: id, confirm: true },
          headers: { "if-match": "1" },
        }),
      ),
    ).toEqual({ status: 403, key: "box_out_of_scope" });
  });

  test("a token that sees a checkpoint may read it, but only its creator may change or delete it", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const boxId = await makeBox("mine", maker.secret);
    const id = (await take(boxId, maker.secret)).id;
    const watcher = mint(harness.app, { name: "watcher", preset: "operator", boxes: { type: "ids", ids: [boxId] } });

    expect((await call(harness.base, `/api/checkpoints/${id}`, { token: watcher.secret })).status).toBe(200);
    expect(
      refused(
        await call(harness.base, `/api/checkpoints/${id}`, {
          token: watcher.secret,
          method: "PATCH",
          body: { label: "theirs" },
        }),
      ),
    ).toEqual({ status: 403, key: "checkpoint_out_of_scope" });
    expect(
      refused(await call(harness.base, `/api/checkpoints/${id}`, { token: watcher.secret, method: "DELETE" })),
    ).toEqual({ status: 403, key: "checkpoint_out_of_scope" });

    const renamed = await call(harness.base, `/api/checkpoints/${id}`, {
      token: maker.secret,
      method: "PATCH",
      body: { label: "mine" },
    });
    expect((await settle(renamed)).result?.checkpoint?.label).toBe("mine");
  });

  test("each action needs its scope, and a token without it is refused by the scope check", async () => {
    const boxId = await makeBox("alpha");
    const id = (await take(boxId)).id;

    const reader = mint(harness.app, { name: "reader", preset: "readonly" });
    expect((await call(harness.base, "/api/checkpoints", { token: reader.secret })).status).toBe(200);
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { token: reader.secret, method: "POST", body: {} }),
      ),
    ).toEqual({ status: 403, key: "operation_forbidden" });

    const taker = mint(harness.app, {
      name: "taker",
      scopes: ["box:read", "checkpoint:create"],
      boxes: { type: "ids", ids: [boxId] },
    });
    expect(
      refused(
        await call(harness.base, `/api/checkpoints/${id}/fork`, {
          token: taker.secret,
          method: "POST",
          body: { name: "copy", cpus: 1, memoryMb: 256 },
        }),
      ),
    ).toEqual({ status: 403, key: "operation_forbidden" });
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/rollback`, {
          token: taker.secret,
          method: "POST",
          body: { checkpoint: id, confirm: true },
          headers: { "if-match": "1" },
        }),
      ),
    ).toEqual({ status: 403, key: "operation_forbidden" });
    expect(
      (
        await settle(
          await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
            token: taker.secret,
            method: "POST",
            body: {},
          }),
        )
      ).status,
    ).toBe("succeeded");
  });

  test("a take naming a shared volume the token cannot see is refused, and a name that matches nothing is a 404", async () => {
    const shared = await call(harness.base, "/api/volumes", {
      method: "POST",
      body: { name: "shared-data", confirm: true },
    });
    expect(shared.status).toBe(201);
    const sharedId = shared.json.volume?.id ?? "";
    const made = await call(harness.base, "/api/boxes", {
      body: { name: "data-box", cpus: 1, memoryMb: 256, mounts: [{ volume: sharedId, path: "/data", mode: "rw" }] },
    });
    const boxId = made.json.box?.boxId ?? "";
    const granted = mint(harness.app, { name: "granted", preset: "operator", boxes: { type: "ids", ids: [boxId] } });

    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
          token: granted.secret,
          method: "POST",
          body: { include: { volumes: [sharedId] } },
        }),
      ),
    ).toEqual({ status: 403, key: "checkpoint_out_of_scope" });
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
          token: granted.secret,
          method: "POST",
          body: { include: { volumes: ["vol_0000000000000000"] } },
        }),
      ),
    ).toEqual({ status: 404, key: "volume_not_found" });

    const owned = await take(boxId, undefined, { include: { volumes: [sharedId] } });
    expect(owned.data.map((layer) => layer.path)).toEqual(["/data"]);
  });

  test("a fork is refused when its template was made by another token, though the token can see the checkpoint", async () => {
    const keys = harness.app.hosts.get().keys;
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    harness.runtime.seedImage("mbtest-template:mine", {
      [keys.template]: "true",
      [keys.templateName]: "mine",
      [keys.createdBy]: maker.id,
    });
    const made = await call(harness.base, "/api/boxes", {
      token: maker.secret,
      body: { name: "from-mine", cpus: 1, memoryMb: 256, template: "mbtest-template:mine" },
    });
    expect(made.status).toBe(201);
    const boxId = made.json.box?.boxId ?? "";
    const id = (await take(boxId, maker.secret)).id;
    const reader = mint(harness.app, { name: "reader", preset: "operator", boxes: { type: "ids", ids: [boxId] } });

    expect((await call(harness.base, `/api/checkpoints/${id}`, { token: reader.secret })).status).toBe(200);
    expect(
      refused(
        await call(harness.base, `/api/checkpoints/${id}/fork`, {
          token: reader.secret,
          method: "POST",
          body: { name: "copy", cpus: 1, memoryMb: 256 },
        }),
      ),
    ).toEqual({ status: 403, key: "template_out_of_scope" });
  });
});

describe("an agent host and checkpoints", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = startHarness();
    harness.app.monitor.snapshot = async () => ROOMY_HOST;
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  /** A box made over REST. The local host stands in for an agent host, as the volume-snapshot test does. */
  async function makeBox(name: string): Promise<string> {
    const reply = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
    expect(reply.status).toBe(201);
    return reply.json.box?.boxId ?? "";
  }

  test("a take is refused with the feature named, before any task starts, and the host is untouched", async () => {
    const boxId = await makeBox("alpha");
    const host = harness.app.hosts.get();
    host.host.transport = "agent";
    try {
      const reply = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body: {} });
      expect(reply).toMatchObject({
        status: 501,
        json: { error: { code: "unsupported", key: "agent_host_unsupported", params: { feature: "checkpoints" } } },
      });
      expect(reply.json).not.toHaveProperty("taskId");
      expect(harness.app.tasks.list({ limit: 10 })).toEqual([]);
      expect(host.checkpoints.list()).toEqual([]);
      expect(harness.runtime.images.size).toBeGreaterThan(0);
    } finally {
      host.host.transport = "local";
    }
  });

  test("an import onto an agent host is refused with the feature named, before any task starts", async () => {
    const host = harness.app.hosts.get();
    host.host.transport = "agent";
    try {
      const reply = await call(harness.base, "/api/packages/pk_neverexisted/import", {
        method: "POST",
        body: { passphrase: "correct horse battery staple" },
      });
      expect(reply).toMatchObject({
        status: 501,
        json: { error: { code: "unsupported", key: "agent_host_unsupported", params: { feature: "checkpoints" } } },
      });
      expect(reply.json).not.toHaveProperty("taskId");
      expect(harness.app.tasks.list({ limit: 10 })).toEqual([]);
    } finally {
      host.host.transport = "local";
    }
  });

  test("the refusal is the operation's, not the runtime's: a plain local host still takes a checkpoint", async () => {
    const boxId = await makeBox("beta");
    const started = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body: {} });
    expect(started.status).toBe(202);
    const done = await finishedTask(harness.base, started.json.taskId ?? "");
    expect(done.status).toBe("succeeded");
    expect(harness.app.hosts.get().checkpoints.list()).toHaveLength(1);
  });
});

describe("a refusal from the operation executor", () => {
  test("a refusal in beforeTask is audited once, as an error, and no task is started", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime } = createTestApp({ labelPrefix: "mbtest" }, undefined, {
      audit: (event) => events.push(event),
    });
    const restoreLogs = silenceLogs();
    try {
      const keys = app.hosts.get().keys;
      runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
      const ctx: OperationContext = {
        host: app.hosts.get(),
        principal: OWNER,
        source: "rest",
        events: app.events,
        tokens: app.tokens,
        execs: app.execs,
        terminals: app.terminals,
      };
      const made = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
        box: { boxId: string };
      };
      const spare = (await app.operations.run("volume.create", ctx, { name: "spare", confirm: true })) as {
        volume: { id: string };
      };

      const error = await rejectionOf(
        app.operations.run("checkpoint.create", ctx, {
          id: made.box.boxId,
          include: { system: false, volumes: [spare.volume.id] },
        }),
      );

      expect(error).toMatchObject({ status: 409, key: "checkpoint_volume_not_mounted" });
      expect(events.filter((event) => event.op === "checkpoint.create")).toEqual([
        expect.objectContaining({ kind: "write", status: "error", error: { code: "conflict", status: 409 } }),
      ]);
      expect(app.tasks.list({ limit: 10 })).toEqual([]);
    } finally {
      restoreLogs();
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    }
  });
});
