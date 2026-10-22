import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import type { Config } from "../src/config";
import type { EngineTarget } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const GIB = 1024 ** 3;
const SMALL_SOCKET = "/run/minibox-test/small-docker.sock";
const LARGE_SOCKET = "/run/minibox-test/large-docker.sock";

type Host = "local" | "small" | "large";

interface Running {
  app: App;
  server: Server<SocketData>;
  base: string;
  local: FakeRuntime;
  small: FakeRuntime;
  large: FakeRuntime;
  restoreLogs: () => void;
}

let running: Running | null = null;

afterEach(() => {
  if (!running) return;
  running.app.hostAdmin.close();
  running.app.sessions.stop();
  running.app.tokens.stop();
  running.server.stop(true);
  running.restoreLogs();
  running = null;
});

function current(): Running {
  if (!running) throw new Error("the test has not booted");
  return running;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${current().base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

type ErrorBody = { code: string; key?: string; params?: Record<string, unknown>; details?: Record<string, unknown> };

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

interface BoxRef {
  id: string;
  boxId: string;
  hostId?: string;
  revision: number;
}

async function boxOn(host: string | undefined, name: string, extra: Record<string, unknown> = {}): Promise<BoxRef> {
  const res = await post("/api/boxes", { name, cpus: 1, memoryMb: 256, host, mounts: [], ...extra });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: BoxRef }).box;
}

/**
 * Two remote engines of different sizes, reached through unix sockets, and a local host. The template is seeded on the
 * hosts named in `templates` only, so a test decides which hosts `auto` may pick from. The local host reports the real
 * machine, so tests place boxes on the remote engines, whose capacity is fixed.
 */
async function boot(overrides: Partial<Config> = {}, templates: Host[] = ["local", "small", "large"]): Promise<void> {
  const restoreLogs = silenceLogs();
  const local = new FakeRuntime();
  const small = new FakeRuntime();
  small.engine = { cpus: 2, memoryBytes: 4 * GIB };
  const large = new FakeRuntime();
  large.engine = { cpus: 8, memoryBytes: 16 * GIB };
  const engines: Record<Host, FakeRuntime> = { local, small, large };
  const app = createApp(testConfig({ labelPrefix: "mbtest", ...overrides }), "0.0.0-test", {
    runtime: local,
    connect: (target: EngineTarget) => ("socketPath" in target && target.socketPath === LARGE_SOCKET ? large : small),
    checkpointEngine: new FakeCheckpointEngine(local),
    eventsPath: ":memory:",
  });
  for (const host of templates) {
    engines[host].seedImage(app.cfg.baseTemplateTag, {
      [app.hosts.get().keys.template]: "true",
      [app.hosts.get().keys.templateName]: "base",
    });
  }
  const server = startServer(app);
  running = { app, server, base: `http://127.0.0.1:${server.port}`, local, small, large, restoreLogs };
  for (const [id, socket] of [
    ["small", SMALL_SOCKET],
    ["large", LARGE_SOCKET],
  ] as const) {
    const res = await post("/api/hosts", { id, endpoint: `unix://${socket}` });
    expect(res.status).toBe(201);
  }
}

describe("a running box books its CPU and memory against the host it runs on", () => {
  test("a box that would push the running boxes past the host's CPU limit is refused, and the refusal gives the total", async () => {
    await boot();
    await boxOn("small", "alpha", { cpus: 1 });

    const res = await post("/api/boxes", { name: "beta", cpus: 2, memoryMb: 256, host: "small", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "insufficient_capacity",
      key: "cpu_booked_over_host",
      params: { booked: 3, limit: 2 },
      details: { field: "cpus" },
    });
    expect(current().small.callsTo("createContainer")).toHaveLength(1);
  });

  test("the overcommit ratio raises the limit that the booked total is held to", async () => {
    await boot({ hostOvercommit: 2 });
    await boxOn("small", "alpha", { cpus: 1 });
    await boxOn("small", "beta", { cpus: 2 });

    const res = await post("/api/boxes", { name: "gamma", cpus: 2, memoryMb: 256, host: "small", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ key: "cpu_booked_over_host", params: { booked: 5, limit: 4 } });
  });

  test("memory is booked the same way, against the memory the host reports", async () => {
    await boot();
    await boxOn("small", "alpha", { memoryMb: 3 * 1024 });

    const res = await post("/api/boxes", { name: "beta", cpus: 1, memoryMb: 2048, host: "small", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      key: "memory_booked_over_host",
      params: { booked: 5, limit: 4 },
      details: { field: "memoryMb" },
    });
  });

  test("a stopped box books nothing, so the host has its room back", async () => {
    await boot();
    const alpha = await boxOn("small", "alpha", { cpus: 2 });
    expect((await api(`/api/boxes/${alpha.boxId}/stop`, { method: "POST" })).status).toBe(200);

    await boxOn("small", "beta", { cpus: 2 });
    expect(current().small.callsTo("createContainer")).toHaveLength(2);
  });

  test("a resize is checked for how much it grows a running box, and a shrink is never refused", async () => {
    await boot();
    const alpha = await boxOn("small", "alpha", { cpus: 1 });
    await boxOn("small", "beta", { cpus: 1 });
    const resize = (body: unknown, revision: number) =>
      api(`/api/boxes/${alpha.boxId}/resources`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "if-match": String(revision) },
      });

    const grown = await resize({ cpus: 2 }, alpha.revision);
    expect(grown.status).toBe(422);
    expect(await errorOf(grown)).toMatchObject({ key: "cpu_booked_over_host", params: { booked: 3, limit: 2 } });

    const shrunk = await resize({ cpus: 0.5 }, alpha.revision);
    expect(shrunk.status).toBe(200);
    const revision = ((await shrunk.json()) as { box: { revision: number } }).box.revision;

    expect((await resize({ memoryMb: 512 }, revision)).status).toBe(200);
  });

  test("a resize of a stopped box is not checked, since it books nothing", async () => {
    await boot();
    const alpha = await boxOn("small", "alpha", { cpus: 1 });
    expect((await api(`/api/boxes/${alpha.boxId}/stop`, { method: "POST" })).status).toBe(200);
    await boxOn("small", "beta", { cpus: 2 });

    const res = await api(`/api/boxes/${alpha.boxId}/resources`, {
      method: "PATCH",
      body: JSON.stringify({ cpus: 2 }),
      headers: { "if-match": String(alpha.revision + 1) },
    });
    expect(res.status).toBe(200);
  });
});

describe("a control plane with one host has no booking check", () => {
  test("two boxes may each take the whole machine, as they always could before hosts existed", async () => {
    await boot();
    expect((await api("/api/hosts/small", { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/hosts/large", { method: "DELETE" })).status).toBe(200);

    const cores = os.cpus().length;
    await boxOn(undefined, "alpha", { cpus: cores });
    const second = await boxOn(undefined, "beta", { cpus: cores });
    expect(second.hostId).toBeUndefined();
    expect(current().local.callsTo("createContainer")).toHaveLength(2);
  });
});

describe("host auto places a new box on the reachable host with the most room", () => {
  test("the host left with the most free CPU and memory once the box is placed wins", async () => {
    await boot({}, ["small", "large"]);
    await boxOn("small", "alpha", { cpus: 1 });

    const placed = await boxOn("auto", "beta", { cpus: 1 });
    expect(placed.hostId).toBe("large");
    expect(current().large.callsTo("createContainer")).toHaveLength(1);
  });

  test("a host without the template is not a candidate, however empty it is", async () => {
    await boot({}, ["small"]);
    await boxOn("small", "alpha", { cpus: 1 });

    const placed = await boxOn("auto", "beta", { cpus: 1 });
    expect(placed.hostId).toBe("small");
    expect(current().large.callsTo("createContainer")).toHaveLength(0);
  });

  test("an offline host is skipped, even when it is the emptiest", async () => {
    await boot({}, ["small", "large"]);
    current().app.hosts.get("large").host.status = "offline";

    const placed = await boxOn("auto", "alpha", { cpus: 1 });
    expect(placed.hostId).toBe("small");
  });

  test("equally free hosts keep the order they were added in", async () => {
    await boot({}, ["small", "large"]);
    current().small.engine = { cpus: 4, memoryBytes: 8 * GIB };
    current().large.engine = { cpus: 4, memoryBytes: 8 * GIB };

    const placed = await boxOn("auto", "alpha", { cpus: 1 });
    expect(placed.hostId).toBe("small");
  });

  test("when no online host holds the template, auto is refused and names the template", async () => {
    await boot({}, []);
    const res = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256, host: "auto", mounts: [] });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ key: "template_image_missing", details: { field: "template" } });
  });

  test("when no host with the template has room for the box, auto is a 422 and no box is made", async () => {
    await boot({}, ["small", "large"]);
    const res = await post("/api/boxes", { name: "alpha", cpus: 16, memoryMb: 256, host: "auto", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "insufficient_capacity", key: "host_auto_no_room" });
    expect(current().large.callsTo("createContainer")).toHaveLength(0);
  });

  test("auto is a reserved word, so no host can be added under that id", async () => {
    await boot();
    const res = await post("/api/hosts", { id: "auto", endpoint: `unix://${SMALL_SOCKET}` });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ key: "host_id_reserved" });
  });
});
