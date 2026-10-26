import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import { generateKeyPairPem } from "../src/agent/identity";
import { AGENT_PROTOCOL } from "../src/agent/protocol";
import { type App, createApp } from "../src/app";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";
const MB = 1024 ** 2;

/** What `GET /api/hosts/{id}/disk` answers. */
interface DiskJson {
  id: string;
  status: string;
  checkedAt: string;
  supported: boolean;
  reason: string | null;
  detail: string | null;
  breakdown: {
    images: EntryJson | null;
    containers: EntryJson | null;
    volumes: EntryJson | null;
    buildCache: EntryJson | null;
  } | null;
}

interface EntryJson {
  count: number | null;
  activeCount: number | null;
  totalBytes: number | null;
  reclaimableBytes: number | null;
}

let app: App;
let server: Server<SocketData>;
let base: string;
let local: FakeRuntime;
let edge: FakeRuntime;
let restoreLogs: () => void;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function diskOf(id: string): Promise<{ status: number; body: DiskJson }> {
  const res = await api(`/api/hosts/${id}/disk`);
  return { status: res.status, body: (await res.json()) as DiskJson };
}

beforeEach(async () => {
  restoreLogs = silenceLogs();
  local = new FakeRuntime();
  edge = new FakeRuntime();
  app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: local,
    connect: () => edge,
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const added = await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` });
  expect(added.status).toBe(201);
});

afterEach(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  app.events.close();
  server.stop(true);
  restoreLogs();
});

describe("what a host's engine holds, over HTTP", () => {
  test("a host reports images, containers, volumes and build cache, with the bytes each takes and frees", async () => {
    local.breakdown = {
      images: { count: 4, activeCount: 2, totalBytes: 600 * MB, reclaimableBytes: 200 * MB },
      containers: { count: 3, activeCount: 1, totalBytes: 30 * MB, reclaimableBytes: 20 * MB },
      volumes: { count: 6, activeCount: 5, totalBytes: 3_000 * MB, reclaimableBytes: 500 * MB },
      buildCache: { count: 9, activeCount: 0, totalBytes: 900 * MB, reclaimableBytes: 900 * MB },
    };

    const { status, body } = await diskOf("local");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: "local",
      supported: true,
      reason: null,
      detail: null,
    });
    // The status is the host's own: a fresh app has not probed it yet.
    expect(["online", "unknown"]).toContain(body.status);
    expect(Date.parse(body.checkedAt)).toBeGreaterThan(0);
    expect(body.breakdown).toEqual({
      images: { count: 4, activeCount: 2, totalBytes: 600 * MB, reclaimableBytes: 200 * MB },
      containers: { count: 3, activeCount: 1, totalBytes: 30 * MB, reclaimableBytes: 20 * MB },
      volumes: { count: 6, activeCount: 5, totalBytes: 3_000 * MB, reclaimableBytes: 500 * MB },
      buildCache: { count: 9, activeCount: 0, totalBytes: 900 * MB, reclaimableBytes: 900 * MB },
    });
  });

  test("a remote host is read too, over its own engine", async () => {
    const { status, body } = await diskOf("edge");
    expect(status).toBe(200);
    expect(body.id).toBe("edge");
    expect(body.breakdown?.images).toEqual(edge.breakdown.images);
    expect(edge.callsTo("diskBreakdown")).toHaveLength(1);
    expect(local.callsTo("diskBreakdown")).toHaveLength(0);
  });

  test("an engine that reports a class without its figures answers nulls for them, not an error", async () => {
    local.breakdown = {
      images: { count: 2, activeCount: null, totalBytes: null, reclaimableBytes: null },
      containers: null,
      volumes: null,
      buildCache: null,
    };

    const { status, body } = await diskOf("local");
    expect(status).toBe(200);
    expect(body.reason).toBeNull();
    expect(body.breakdown).toEqual({
      images: { count: 2, activeCount: null, totalBytes: null, reclaimableBytes: null },
      containers: null,
      volumes: null,
      buildCache: null,
    });
  });

  test("an engine that refuses the read leaves the page working: the answer is null with a reason, not a 500", async () => {
    local.fail("diskBreakdown", new RuntimeError("engine", "boom", "the engine said no"));

    const { status, body } = await diskOf("local");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      supported: true,
      reason: "engine",
      detail: "the engine said no",
      breakdown: null,
    });
  });

  test("an engine that does not answer in the host's read timeout is cut off, and the request still answers", async () => {
    const host = app.hosts.get("edge");
    host.readTimeoutMs = 40;
    const hung = edge.hold("diskBreakdown");
    try {
      const started = performance.now();
      const { status, body } = await diskOf("edge");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: "edge", supported: true, reason: "timeout", breakdown: null });
    } finally {
      hung.release();
    }
  });

  test("a host that is offline reports that, without asking its engine", async () => {
    edge.down = true;
    await app.hostAdmin.refresh();
    expect(app.hosts.get("edge").host.status).toBe("offline");
    const before = edge.calls.length;

    const { status, body } = await diskOf("edge");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "offline", supported: true, reason: "offline", breakdown: null });
    expect(edge.calls.length).toBe(before);
  });

  test("a host id no host carries is a 404", async () => {
    const res = await api("/api/hosts/nowhere/disk");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { key: string } }).error.key).toBe("host_not_found");
  });

  test("the host list keeps the fields it had, so the reading is a pure addition", async () => {
    const list = (await (await api("/api/hosts")).json()) as { hosts: Record<string, unknown>[] };
    const ids = list.hosts.map((host) => host.id);
    expect(ids).toEqual(["local", "edge"]);
    for (const host of list.hosts) expect(Object.keys(host)).not.toContain("disk");
  });
});

describe("an agent host has no docker system df reading", () => {
  test("its runtime refuses the read as unsupported, the way it refuses diskUsage", async () => {
    // The agent runtime is what a paired host's calls cross; it refuses this read rather than measuring the agent's
    // engine, so the caller degrades the same way whether or not the agent is connected.
    const runtime = app.agents.runtimeFor("0".repeat(32));
    const diskError = await runtime.diskBreakdown().catch((e: unknown) => e);
    expect(diskError).toBeInstanceOf(RuntimeError);
    expect(diskError).toMatchObject({ kind: "unsupported", detail: "diskBreakdown is refused" });
    expect((await runtime.diskUsage("/").catch((e: unknown) => e)) as RuntimeError).toMatchObject({
      kind: "unsupported",
      detail: "diskUsage is refused",
    });
  });

  test("a paired agent host answers supported false with a reason, and its engine is never asked", async () => {
    const issued = await post("/api/hosts/pairing", { id: "edge-agent" });
    expect(issued.status).toBe(201);
    const { code } = (await issued.json()) as { code: string };
    const paired = await fetch(`${base}/api/agent/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        publicKey: generateKeyPairPem().publicKeyPem,
        version: "0.4.0",
        protocol: AGENT_PROTOCOL,
      }),
    });
    expect(paired.status).toBe(201);
    expect(app.hosts.get("edge-agent").host.transport).toBe("agent");
    const before = edge.calls.length;

    const { status, body } = await diskOf("edge-agent");
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: "edge-agent", supported: false, reason: "agent_host", breakdown: null });
    expect(edge.calls.length).toBe(before);
  });
});
