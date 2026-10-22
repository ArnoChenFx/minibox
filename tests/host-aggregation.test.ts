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

type Listed = { boxes: { name: string; hostId?: string; state: string }[] };

async function listBoxes(): Promise<Listed["boxes"]> {
  const res = await api("/api/boxes");
  expect(res.status).toBe(200);
  return ((await res.json()) as Listed).boxes;
}

/** Stops the host's event subscription, so a list reads the engine directly instead of the cache it keeps. */
function readEngineDirectly(id: string): void {
  app.hosts.get(id).sampler.stop();
}

beforeEach(async () => {
  restoreLogs = silenceLogs();
  local = new FakeRuntime();
  edge = new FakeRuntime();
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
  const created = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256, host: "edge" });
  expect(created.status).toBe(201);
  const beta = await post("/api/boxes", { name: "beta", cpus: 1, memoryMb: 256, mounts: [] });
  expect(beta.status).toBe(201);
});

afterEach(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  server.stop(true);
  restoreLogs();
});

describe("a remote host that does not answer does not hold up the list", () => {
  test("a hung engine is cut off at its read timeout, and its boxes are listed as unreachable", async () => {
    const edgeHost = app.hosts.get("edge");
    edgeHost.readTimeoutMs = 50;
    readEngineDirectly("edge");
    const hung = edge.hold("listContainers");
    try {
      const started = performance.now();
      const boxes = await listBoxes();
      expect(performance.now() - started).toBeLessThan(2000);
      expect(boxes.map((box) => [box.name, box.hostId, box.state])).toEqual([
        ["alpha", "edge", "unreachable"],
        ["beta", "local", "running"],
      ]);
    } finally {
      hung.release();
    }
  });

  test("a remote engine that fails is listed as unreachable, and the local boxes still show", async () => {
    readEngineDirectly("edge");
    edge.fail("listContainers", new RuntimeError("unavailable", "connect ECONNREFUSED edge-docker.sock"));
    const boxes = await listBoxes();
    expect(boxes.find((box) => box.name === "alpha")?.state).toBe("unreachable");
    expect(boxes.find((box) => box.name === "beta")?.hostId).toBe("local");
  });

  test("an offline host's boxes are listed without any call to its engine", async () => {
    edge.down = true;
    await app.hostAdmin.refresh();
    expect(app.hosts.get("edge").host.status).toBe("offline");
    readEngineDirectly("edge");
    const before = edge.calls.length;

    const boxes = await listBoxes();
    expect(boxes.find((box) => box.name === "alpha")).toMatchObject({ state: "unreachable", hostId: "edge" });
    expect(edge.calls.length).toBe(before);
  });

  test("an offline host keeps its entry in the host list, with the reason it is offline", async () => {
    edge.down = true;
    await app.hostAdmin.refresh();
    const res = await api("/api/hosts");
    const { hosts } = (await res.json()) as {
      hosts: { id: string; status: string; error: string | null; boxes: number }[];
    };
    expect(hosts.find((host) => host.id === "edge")).toMatchObject({ status: "offline", boxes: 1 });
    expect(hosts.find((host) => host.id === "edge")?.error).toContain("ECONNREFUSED");
  });

  test("the volume list leaves out an offline host's volumes, and still lists the local ones", async () => {
    const gamma = await post("/api/boxes", { name: "gamma", cpus: 1, memoryMb: 256, host: "local" });
    expect(gamma.status).toBe(201);
    edge.down = true;
    await app.hostAdmin.refresh();

    const res = await api("/api/volumes");
    expect(res.status).toBe(200);
    const { volumes } = (await res.json()) as { volumes: { hostId: string }[] };
    expect(volumes.length).toBeGreaterThan(0);
    expect(new Set(volumes.map((volume) => volume.hostId))).toEqual(new Set(["local"]));
    expect(edge.volumes.size).toBeGreaterThan(0);
  });
});

describe("a failure on the local host still fails the list", () => {
  test("when the local engine cannot list its boxes, the request fails as unavailable", async () => {
    readEngineDirectly("local");
    local.fail("listContainers", new RuntimeError("unavailable", "connect ECONNREFUSED docker.sock"));
    const res = await api("/api/boxes");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("docker_unavailable");
  });
});
