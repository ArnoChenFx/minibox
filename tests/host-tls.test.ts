import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { hostsPath } from "../src/data-dir";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { type TlsFakeEngine, startTlsFakeEngine } from "./support/engines";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { type TestPki, testPki } from "./support/pki";

const GIB = 1024 ** 3;

let app: App;
let server: Server<SocketData>;
let base: string;
let engine: TlsFakeEngine;
let pki: TestPki;
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

const labEndpoint = () => `tcp://127.0.0.1:${engine.port}`;

beforeAll(() => {
  restoreLogs = silenceLogs();
  pki = testPki();
  engine = startTlsFakeEngine(
    { ca: pki.ca, cert: pki.engine.cert, key: pki.engine.key },
    { cpus: 16, memoryBytes: 32 * GIB, version: "27.0.0-tls" },
  );
  const local = new FakeRuntime();
  app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: local,
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  app.events.close();
  server.stop(true);
  engine.stop();
  restoreLogs();
});

describe("a TCP host, reached over mutual TLS", () => {
  test("an engine that trusts the control plane's certificate is added, online, with its capacity", async () => {
    const res = await post("/api/hosts", {
      id: "lab",
      name: "Lab",
      endpoint: labEndpoint(),
      ca: pki.client.ca,
      cert: pki.client.cert,
      key: pki.client.key,
    });
    expect(res.status).toBe(201);
    const { host } = (await res.json()) as { host: Record<string, unknown> };
    expect(host).toMatchObject({
      id: "lab",
      transport: "tcp",
      status: "online",
      capacity: { cpus: 16, memoryBytes: 32 * GIB },
      dockerVersion: "27.0.0-tls",
    });
    expect(engine.requests).toEqual(expect.arrayContaining(["GET /_ping", "GET /info", "GET /version"]));
  });

  test("the certificate files are owner-only and the hosts file names the endpoint without a credential", () => {
    const dir = join(app.cfg.dataDir, "hosts", "lab");
    for (const name of ["ca.pem", "cert.pem", "key.pem"]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    const text = readFileSync(hostsPath(app.cfg.dataDir), "utf8");
    expect(JSON.parse(text).hosts[0]).toMatchObject({ id: "lab", endpoint: labEndpoint(), hostKeyFingerprint: null });
    expect(text).not.toContain("PRIVATE KEY");
  });

  test("an engine that does not trust the control plane's certificate refuses it, and nothing is saved", async () => {
    const res = await post("/api/hosts", {
      id: "rogue",
      endpoint: labEndpoint(),
      ca: pki.client.ca,
      cert: pki.stranger.cert,
      key: pki.stranger.key,
    });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: "docker_unavailable" });
    expect(app.hosts.has("rogue")).toBe(false);
    expect(existsSync(join(app.cfg.dataDir, "hosts", "rogue"))).toBe(false);
  });

  test("a control plane that does not trust the engine's certificate does not connect to it", async () => {
    const requests = engine.requests.length;
    const res = await post("/api/hosts/test", {
      id: "rogue",
      endpoint: labEndpoint(),
      ca: pki.otherCa,
      cert: pki.client.cert,
      key: pki.client.key,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; error: { key: string } | null };
    expect(body).toMatchObject({ ok: false, status: "offline" });
    expect(body.error?.key).toBe("host_unreachable");
    expect(engine.requests.length).toBe(requests);
  });

  test("a TCP host added without its client certificate is refused, and the missing field is named", async () => {
    const res = await post("/api/hosts", { id: "lab2", endpoint: labEndpoint(), ca: pki.client.ca });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "validation_failed", details: { field: "cert" } });
    expect(app.hosts.has("lab2")).toBe(false);
  });

  test("removing the host deletes its certificate files", async () => {
    const res = await api("/api/hosts/lab", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(app.cfg.dataDir, "hosts", "lab"))).toBe(false);
    expect(app.hosts.has("lab")).toBe(false);
  });
});
