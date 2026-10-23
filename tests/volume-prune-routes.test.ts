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

const rowsOf = (json: Record<string, unknown>) => json.volumes as { name: string; status: string }[];

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

    const removed = await send(base, "POST", "/api/volumes/prune", { dryRun: false });
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

  test("a token without volume:delete is refused, and nothing is listed or removed", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);
    const token = await tokenWith(base, "tidy", { scopes: ["volume:read", "volume:write"] });

    const res = await send(base, "POST", "/api/volumes/prune", { dryRun: false }, token);
    expect(res.status).toBe(403);
    expect(host.volumes.list().map((volume) => volume.name)).toContain("alpha-workspace");
  });

  test("a token with volume:delete prunes only the volumes it created", async () => {
    const { app, host, base } = start();
    const token = await tokenWith(base, "maker", { scopes: ["volume:write", "volume:read", "volume:delete"] });
    const made = await send(base, "POST", "/api/volumes", { name: "mine", confirm: true }, token);
    expect(made.status).toBe(201);
    await createVolume(host, { name: "theirs", role: null, createdBy: "owner" });
    ageVolumes(host);

    const asToken = await send(base, "POST", "/api/volumes/prune", {}, token);
    expect(rowsOf(asToken.json).map((row) => row.name)).toEqual(["mine"]);

    const asOwner = await send(base, "POST", "/api/volumes/prune", {});
    expect(
      rowsOf(asOwner.json)
        .map((row) => row.name)
        .toSorted(),
    ).toEqual(["mine", "theirs"]);
    expect(app.activity.list().filter((entry) => entry.action === "volume.prune")).toHaveLength(0);
  });

  test("a token not granted this host is refused, as a volume list is, and prunes nothing", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);
    const token = await tokenWith(base, "remote", { scopes: ["volume:delete"], hosts: ["other"] });

    const res = await send(base, "POST", "/api/volumes/prune", { dryRun: false }, token);
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ key: "host_not_granted" });
    expect(host.volumes.list().map((volume) => volume.name)).toContain("alpha-workspace");
  });

  test("a removal is recorded in the activity feed, once for each volume and once for the prune", async () => {
    const { app, host, base } = start();
    await orphanedAlpha(app, host);

    await send(base, "POST", "/api/volumes/prune", {});
    expect(app.activity.list()).toHaveLength(0);

    await send(base, "POST", "/api/volumes/prune", { dryRun: false });
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
