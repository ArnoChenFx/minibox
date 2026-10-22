import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const GIB = 1024 ** 3;
const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";

let app: App;
let server: Server<SocketData>;
let base: string;
let local: FakeRuntime;
let edge: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

type ErrorBody = { code: string; key?: string; details?: Record<string, unknown> };

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

async function boxOn(host: string | undefined, name: string, extra: Record<string, unknown> = {}) {
  const res = await post("/api/boxes", { name, cpus: 1, memoryMb: 256, host, ...extra });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string; boxId: string; hostId?: string; state: string } }).box;
}

beforeEach(async () => {
  restoreLogs = silenceLogs();
  local = new FakeRuntime();
  edge = new FakeRuntime();
  edge.engine = { cpus: 2, memoryBytes: 4 * GIB };
  app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: local,
    connect: () => edge,
    checkpointEngine: new FakeCheckpointEngine(local),
    eventsPath: ":memory:",
  });
  keys = app.hosts.get().keys;
  for (const runtime of [local, edge]) {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  }
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const added = await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` });
  expect(added.status).toBe(201);
});

afterEach(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  server.stop(true);
  restoreLogs();
});

describe("box operations go to the host the box lives on", () => {
  test("a box created on another host runs on that host's engine and is recorded against it", async () => {
    const box = await boxOn("edge", "alpha");
    expect(box.hostId).toBe("edge");
    expect(edge.callsTo("createContainer")).toHaveLength(1);
    expect(local.callsTo("createContainer")).toHaveLength(0);
    expect(
      app.hosts
        .get("edge")
        .specs.list()
        .map((spec) => [spec.name, spec.hostId]),
    ).toEqual([["alpha", "edge"]]);
  });

  test("reads and logs of a box never touch the engine of another host", async () => {
    const box = await boxOn("edge", "alpha");
    const localCalls = local.calls.length;
    const edgeCalls = edge.calls.length;

    expect((await api(`/api/boxes/${box.boxId}`)).status).toBe(200);
    expect((await api(`/api/boxes/${box.boxId}/logs`)).status).toBe(200);

    expect(local.calls.length).toBe(localCalls);
    expect(edge.calls.length).toBeGreaterThan(edgeCalls);
    expect(edge.callsTo("inspectContainer").length).toBeGreaterThan(0);
  });

  test("a box created without a host is on the local host, which is the default", async () => {
    const box = await boxOn(undefined, "beta");
    expect(box.hostId).toBe("local");
    expect(local.callsTo("createContainer")).toHaveLength(1);
    expect(edge.callsTo("createContainer")).toHaveLength(0);
  });

  test("a box name is unique across hosts, since specs are shared", async () => {
    await boxOn("local", "shared-name");
    const res = await post("/api/boxes", { name: "shared-name", cpus: 1, memoryMb: 256, host: "edge" });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "conflict", key: "box_exists" });
  });

  test("creating a box on a host that is not added is a 404", async () => {
    const res = await post("/api/boxes", { name: "orphan", cpus: 1, memoryMb: 256, host: "nowhere" });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "not_found", key: "host_not_found" });
  });
});

describe("the list names each box's host and can be narrowed to one host", () => {
  test("with two hosts, every box says where it runs, and ?host= narrows the list", async () => {
    await boxOn(undefined, "beta");
    await boxOn("edge", "alpha");

    const all = (await (await api("/api/boxes")).json()) as { boxes: { name: string; hostId?: string }[] };
    expect(all.boxes.map((box) => [box.name, box.hostId])).toEqual([
      ["alpha", "edge"],
      ["beta", "local"],
    ]);

    const onEdge = (await (await api("/api/boxes?host=edge")).json()) as { boxes: { name: string }[] };
    expect(onEdge.boxes.map((box) => box.name)).toEqual(["alpha"]);

    const unknown = await api("/api/boxes?host=nowhere");
    expect(unknown.status).toBe(404);
  });

  test("with one host, a box payload carries no host field, as before hosts existed", async () => {
    const removed = await api("/api/hosts/edge", { method: "DELETE" });
    expect(removed.status).toBe(200);
    const box = await boxOn(undefined, "solo");
    expect("hostId" in box).toBe(false);
    const listed = (await (await api("/api/boxes")).json()) as { boxes: Record<string, unknown>[] };
    expect(listed.boxes.every((item) => !("hostId" in item))).toBe(true);
  });
});

describe("capacity is checked against the host the box is created on", () => {
  test("a box larger than its host's engine is refused there, and still fits on a larger host", async () => {
    const tooManyCpus = await post("/api/boxes", { name: "wide", cpus: 3, memoryMb: 256, host: "edge" });
    expect(tooManyCpus.status).toBe(422);
    expect(await errorOf(tooManyCpus)).toMatchObject({
      code: "insufficient_capacity",
      details: { field: "cpus" },
    });

    const tooMuchMemory = await post("/api/boxes", { name: "deep", cpus: 1, memoryMb: 8192, host: "edge" });
    expect(tooMuchMemory.status).toBe(422);
    expect(await errorOf(tooMuchMemory)).toMatchObject({
      code: "insufficient_capacity",
      details: { field: "memoryMb" },
    });

    await boxOn("local", "wide", { cpus: 3 });
    expect(edge.callsTo("createContainer")).toHaveLength(0);
  });

  test("the host's capacity is what its engine reports", async () => {
    const hosts = (await (await api("/api/hosts")).json()) as { hosts: { id: string; capacity: unknown }[] };
    expect(hosts.hosts.find((host) => host.id === "edge")?.capacity).toEqual({ cpus: 2, memoryBytes: 4 * GIB });
  });
});

describe("a host that still holds boxes cannot be removed", () => {
  test("removal is refused while a box lives there, and allowed once it is gone", async () => {
    const box = await boxOn("edge", "alpha", { mounts: [] });

    const refused = await api("/api/hosts/edge", { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({
      code: "conflict",
      key: "host_in_use",
      details: { boxes: 1, volumes: 0, checkpoints: 0, total: 1 },
    });
    expect(app.hosts.has("edge")).toBe(true);

    expect((await api(`/api/boxes/${box.boxId}`, { method: "DELETE" })).status).toBe(200);
    const removed = await api("/api/hosts/edge", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(app.hosts.has("edge")).toBe(false);
  });

  test("the local host cannot be removed", async () => {
    const res = await api("/api/hosts/local", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "conflict", key: "host_is_local" });
  });

  test("a failing engine on one host does not fail a box on another host", async () => {
    const box = await boxOn("local", "beta");
    edge.fail("inspectContainer", new RuntimeError("engine", "boom"));
    expect((await api(`/api/boxes/${box.boxId}`)).status).toBe(200);
  });
});
