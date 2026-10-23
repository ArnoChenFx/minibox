import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { createVolume } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Running {
  app: App;
  runtime: FakeRuntime;
  host: HostCtx;
  base: string;
  stop: () => void;
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

let restoreLogs: () => void;
let running: Running | undefined;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  running?.stop();
  running = undefined;
  restoreLogs();
});

function start(): Running {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const server = startServer(app);
  const started: Running = {
    app,
    runtime,
    host: app.hosts.get(),
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    },
  };
  running = started;
  return started;
}

async function send(base: string, method: string, path: string, body?: unknown, token = TEST_KEY): Promise<Reply> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function tokenWith(base: string, name: string, body: Record<string, unknown>): Promise<string> {
  const made = await send(base, "POST", "/api/tokens", { name, ...body });
  expect(made.status).toBe(201);
  return String(made.json.token);
}

/** Moves every volume's creation and last mount a month back, so the grace period has passed for each. */
function ageVolumes(host: HostCtx): void {
  const old = new Date(Date.now() - 30 * DAY_MS).toISOString();
  for (const record of host.volumes.list()) {
    host.volumes.write({
      ...record,
      createdAt: old,
      lastMount: record.lastMount ? { ...record.lastMount, at: old } : null,
    });
  }
}

/** A box alpha whose volumes were kept when it was deleted, so they are orphans. */
async function orphanedAlpha(app: App, host: HostCtx): Promise<void> {
  const alpha = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256 });
  await boxes.deleteBox(host, alpha.boxId, false);
  ageVolumes(host);
  expect(app.activity.list()).toHaveLength(0);
}

const rowsOf = (json: Record<string, unknown>) =>
  json.volumes as { id: string; name: string; status: string; keepsCopy: boolean; error: { key: string } | null }[];

/** A dry run, then a prune of exactly the volumes it listed, as the Volumes page and the CLI send it. */
async function pruneListed(base: string): Promise<Reply> {
  const listed = await send(base, "POST", "/api/volumes/prune", {});
  expect(listed.status).toBe(200);
  return send(base, "POST", "/api/volumes/prune", { dryRun: false, ids: rowsOf(listed.json).map((row) => row.id) });
}

describe("POST /api/volumes/prune", () => {
  test("a request without dryRun only lists the orphans, and dryRun false removes them", async () => {
    const { app, runtime, host, base } = start();
    await orphanedAlpha(app, host);

    const listed = await send(base, "POST", "/api/volumes/prune", {});
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({ dryRun: true, olderThan: null });
    expect(rowsOf(listed.json).map((row) => row.status)).toEqual(rowsOf(listed.json).map(() => "candidate"));
    expect(rowsOf(listed.json).map((row) => row.name)).toContain("alpha-workspace");
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
    expect(app.activity.list()).toHaveLength(0);

    const ids = rowsOf(listed.json).map((row) => row.id);
    const removed = await send(base, "POST", "/api/volumes/prune", { dryRun: false, ids });
    expect(removed.status).toBe(200);
    expect(rowsOf(removed.json).every((row) => row.status === "removed")).toBe(true);
    expect(host.volumes.list().map((volume) => volume.name)).not.toContain("alpha-workspace");
  });

  test("a prune with no body at all is a dry run", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);

    const res = await fetch(`${base}/api/volumes/prune`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dryRun: boolean }).dryRun).toBe(true);
  });

  test("olderThan keeps the volumes used more recently than the span, and a value that is not a span is refused", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);

    const older = await send(base, "POST", "/api/volumes/prune", { olderThan: "7d" });
    expect(older.status).toBe(200);
    expect(older.json).toMatchObject({ olderThan: "7d" });
    expect(rowsOf(older.json).map((row) => row.name)).toContain("alpha-workspace");

    const recent = await send(base, "POST", "/api/volumes/prune", { olderThan: "60d" });
    expect(recent.status).toBe(200);
    expect(recent.json).toMatchObject({ olderThan: "60d" });
    expect(rowsOf(recent.json)).toEqual([]);

    const nonsense = await send(base, "POST", "/api/volumes/prune", { olderThan: "soon" });
    expect(nonsense.status).toBe(400);
    expect(nonsense.json.error).toMatchObject({ key: "volume_older_than_invalid" });
  });

  test("a prune that removes volumes must name them, and a request with no ids removes nothing", async () => {
    const { app, runtime, host, base } = start();
    await orphanedAlpha(app, host);

    const bare = await send(base, "POST", "/api/volumes/prune", { dryRun: false });
    expect(bare.status).toBe(400);
    expect(bare.json.error).toMatchObject({ key: "volume_prune_ids_required" });
    const empty = await send(base, "POST", "/api/volumes/prune", { dryRun: false, ids: [] });
    expect(empty.status).toBe(400);
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
    expect(host.volumes.list().map((volume) => volume.name)).toContain("alpha-workspace");
  });

  test("a confirmed prune removes only the volumes it names, even when more orphans appeared since the preview", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);
    const listed = await send(base, "POST", "/api/volumes/prune", {});
    const previewed = rowsOf(listed.json).map((row) => row.id);
    expect(previewed.length).toBeGreaterThan(0);

    // A box deleted after the preview leaves more orphans: the confirmation was not about them.
    const beta = await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 256 });
    await boxes.deleteBox(host, beta.boxId, false);
    ageVolumes(host);

    const removed = await send(base, "POST", "/api/volumes/prune", { dryRun: false, ids: previewed });
    expect(removed.status).toBe(200);
    expect(rowsOf(removed.json).map((row) => row.id)).toEqual(previewed);
    expect(rowsOf(removed.json).every((row) => row.status === "removed")).toBe(true);
    const left = host.volumes.list().map((volume) => volume.name);
    expect(left).toContain("beta-workspace");
    expect(left).not.toContain("alpha-workspace");
  });

  test("a named volume a live box took back since the preview, and an unknown id, are refused with their reasons", async () => {
    const { app, runtime, host, base } = start();
    await orphanedAlpha(app, host);
    const listed = await send(base, "POST", "/api/volumes/prune", {});
    const workspace = rowsOf(listed.json).find((row) => row.name === "alpha-workspace");
    if (!workspace) throw new Error("alpha-workspace was not listed");

    // A box claims the previewed volume before the owner confirms: it is no longer an orphan.
    const gamma = await boxes.createBox(host, { name: "gamma", cpus: 1, memoryMb: 256 });
    const record = host.volumes.read(workspace.id);
    if (!record) throw new Error("alpha-workspace has no record");
    host.volumes.write({ ...record, ownership: "owned", ownerBoxId: gamma.boxId });

    const res = await send(base, "POST", "/api/volumes/prune", {
      dryRun: false,
      ids: [workspace.id, "vol_doesnotexist"],
    });
    expect(res.status).toBe(200);
    const rows = rowsOf(res.json);
    expect(rows.map((row) => [row.name, row.status, row.error?.key])).toEqual([
      ["alpha-workspace", "refused", "volume_not_orphan"],
      ["vol_doesnotexist", "refused", "volume_not_found"],
    ]);
    expect(host.volumes.read(workspace.id)).not.toBeNull();
    expect(runtime.callsTo("removeVolume")).toHaveLength(0);
  });

  test("a token is refused even with volume:delete, as pruning is the owner's alone, and nothing is removed", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);
    const listed = await send(base, "POST", "/api/volumes/prune", {});
    const ids = rowsOf(listed.json).map((row) => row.id);
    for (const scopes of [
      ["volume:read", "volume:write"],
      ["volume:read", "volume:write", "volume:delete"],
    ]) {
      const token = await tokenWith(base, `tidy-${scopes.length}`, { scopes });
      const dry = await send(base, "POST", "/api/volumes/prune", {}, token);
      expect(dry.status).toBe(403);
      const res = await send(base, "POST", "/api/volumes/prune", { dryRun: false, ids }, token);
      expect(res.status).toBe(403);
    }
    expect(host.volumes.list().map((volume) => volume.name)).toContain("alpha-workspace");
  });

  test("a removal is recorded in the activity feed, once for each volume and once for the prune", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);

    await send(base, "POST", "/api/volumes/prune", {});
    expect(app.activity.list()).toHaveLength(0);

    await pruneListed(base);
    const entries = app.activity.list();
    expect(entries).toContainEqual(
      expect.objectContaining({ action: "volume.prune", target: "alpha-workspace", ok: true }),
    );
    expect(entries).toContainEqual(expect.objectContaining({ action: "volume.prune", target: "volumes", ok: true }));
  });
});

describe("POST /api/volumes/delete", () => {
  test("without confirm it returns the preview, which names each volume's blocker, and deletes nothing", async () => {
    const { app, host, base } = start();
    await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256 });
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });

    const preview = await send(base, "POST", "/api/volumes/delete", { ids: ["notes", "alpha-workspace"] });
    expect(preview.status).toBe(409);
    expect(preview.json.error).toMatchObject({
      code: "confirmation_required",
      details: {
        preview: {
          action: "delete_volumes",
          volumes: [
            expect.objectContaining({ name: "notes", blocked: null }),
            expect.objectContaining({ name: "alpha-workspace", blocked: "in_use" }),
          ],
        },
      },
    });
    expect(host.volumes.list().map((volume) => volume.name)).toEqual(
      expect.arrayContaining(["notes", "alpha-workspace"]),
    );
    expect(app.activity.list()).toHaveLength(0);
  });

  test("with confirm it reports each volume in the order named, and records each deletion", async () => {
    const { app, host, base } = start();
    await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256 });
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });

    const deleted = await send(base, "POST", "/api/volumes/delete", {
      ids: ["alpha-workspace", "notes"],
      confirm: true,
    });
    expect(deleted.status).toBe(200);
    expect(rowsOf(deleted.json).map((row) => [row.name, row.status])).toEqual([
      ["alpha-workspace", "refused"],
      ["notes", "removed"],
    ]);
    expect(app.activity.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "volume.delete", target: "notes", ok: true }),
        expect.objectContaining({ action: "volume.delete", target: "2 volumes", ok: true }),
      ]),
    );
  });

  test("a token deletes only the volumes it created, and refuses the others as forbidden", async () => {
    const { host, base } = start();
    const token = await tokenWith(base, "maker", { scopes: ["volume:write", "volume:delete"] });
    await send(base, "POST", "/api/volumes", { name: "mine", confirm: true }, token);
    await createVolume(host, { name: "theirs", role: null, createdBy: "owner" });

    const res = await send(base, "POST", "/api/volumes/delete", { ids: ["theirs", "mine"], confirm: true }, token);
    expect(res.status).toBe(200);
    expect(rowsOf(res.json).map((row) => [row.name, row.status])).toEqual([
      ["theirs", "refused"],
      ["mine", "removed"],
    ]);
    expect(host.volumes.list().map((volume) => volume.name)).toEqual(["theirs"]);
  });

  test("a token without volume:delete is refused", async () => {
    const { host, base } = start();
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const token = await tokenWith(base, "reader", { scopes: ["volume:read", "volume:write"] });

    const res = await send(base, "POST", "/api/volumes/delete", { ids: ["notes"], confirm: true }, token);
    expect(res.status).toBe(403);
    expect(host.volumes.list().map((volume) => volume.name)).toEqual(["notes"]);
  });

  test("skipTrash needs the trash:skip scope as well, for a token", async () => {
    const { host, base } = start();
    const token = await tokenWith(base, "maker", { scopes: ["volume:write", "volume:delete"] });
    await send(base, "POST", "/api/volumes", { name: "mine", confirm: true }, token);
    ageVolumes(host);

    const res = await send(
      base,
      "POST",
      "/api/volumes/delete",
      { ids: ["mine"], confirm: true, skipTrash: true },
      token,
    );
    expect(res.status).toBe(403);
    expect(host.volumes.list().map((volume) => volume.name)).toEqual(["mine"]);
  });

  test("the request takes one to 100 ids", async () => {
    const { base } = start();

    expect((await send(base, "POST", "/api/volumes/delete", { ids: [], confirm: true })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, index) => `volume-${index}`);
    expect((await send(base, "POST", "/api/volumes/delete", { ids: tooMany, confirm: true })).status).toBe(400);
  });
});
