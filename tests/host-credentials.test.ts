import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { setLogLevel } from "../src/lib/logger";
import type { ExecutorHooks } from "../src/operations/executor";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { TEST_KEY, testConfig } from "./support/app";
import { type TlsFakeEngine, startTlsFakeEngine } from "./support/engines";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { type TestPki, testPki } from "./support/pki";

let app: App;
let server: Server<SocketData>;
let base: string;
let engine: TlsFakeEngine;
let pki: TestPki;
let audits: unknown[];
let logged: string[];
let restoreConsole: () => void;

/** Every base64 line of the credentials. A leak of any of them, however it is printed, is a leak of the secret. */
function secretLines(): string[] {
  return [pki.client.key, pki.client.cert, pki.client.ca].flatMap((pem) =>
    pem.split("\n").filter((line) => line.length >= 40),
  );
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

const labBody = () => ({
  id: "lab",
  name: "Lab",
  endpoint: `tcp://127.0.0.1:${engine.port}`,
  ca: pki.client.ca,
  cert: pki.client.cert,
  key: pki.client.key,
});

beforeAll(() => {
  pki = testPki();
  engine = startTlsFakeEngine({ ca: pki.ca, cert: pki.engine.cert, key: pki.engine.key });
  audits = [];
  logged = [];
  const sink = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  const errors = spyOn(console, "error").mockImplementation(sink);
  const logs = spyOn(console, "log").mockImplementation(sink);
  restoreConsole = () => {
    errors.mockRestore();
    logs.mockRestore();
  };
  setLogLevel("debug");
  const local = new FakeRuntime();
  app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: local,
    checkpointEngine: new FakeCheckpointEngine(local),
    eventsPath: ":memory:",
    hooks: { audit: (event) => audits.push(event) } as Partial<ExecutorHooks>,
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  setLogLevel("info");
  restoreConsole();
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  app.events.close();
  server.stop(true);
  engine.stop();
});

describe("credentials never leave the control plane", () => {
  test("adding a host with its certificates answers without any of them", async () => {
    const res = await post("/api/hosts", labBody());
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain('"status":"online"');
    for (const line of secretLines()) expect(text).not.toContain(line);
    expect(text).not.toContain("PRIVATE KEY");
  });

  test("testing a host, listing hosts and reading the hosts file show no credential", async () => {
    const tested = await post("/api/hosts/test", labBody());
    expect(tested.status).toBe(200);
    const listed = await api("/api/hosts");
    const file = readFileSync(join(app.cfg.dataDir, "hosts.json"), "utf8");
    for (const text of [await tested.text(), await listed.text(), file]) {
      for (const line of secretLines()) expect(text).not.toContain(line);
      expect(text).not.toContain("PRIVATE KEY");
    }
  });

  test("the certificates are stored as files, and the hosts file holds none of their text", async () => {
    const hostDir = join(app.cfg.dataDir, "hosts", "lab");
    expect(readdirSync(hostDir).toSorted()).toEqual(["ca.pem", "cert.pem", "key.pem"]);
    expect(readFileSync(join(hostDir, "key.pem"), "utf8")).toContain(pki.client.key.split("\n")[1] ?? "");
    const hostsFile = readFileSync(join(app.cfg.dataDir, "hosts.json"), "utf8");
    expect(hostsFile).not.toContain(pki.client.key.split("\n")[1] ?? "");
  });

  test("a refused request names the field at fault, and does not echo the value it was given", async () => {
    const badKey =
      "-----BEGIN PRIVATE KEY-----\nnotakey-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----";
    const res = await post("/api/hosts/test", { ...labBody(), id: "other", key: badKey });
    const text = await res.text();
    expect(text).not.toContain("notakey");

    const encrypted = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----";
    const refused = await post("/api/hosts", { ...labBody(), id: "other", key: encrypted });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain("AAAA");
  });

  test("an endpoint with a password is refused without repeating the password", async () => {
    const res = await post("/api/hosts", { id: "pw", endpoint: "tcp://user:hunter2-secret@127.0.0.1:1" });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("hunter2-secret");
  });

  test("the audit trail records the host and its endpoint, never the certificates", async () => {
    const added = audits.filter((event) => (event as { op?: string }).op === "host.add");
    expect(added.length).toBeGreaterThan(0);
    const text = JSON.stringify(audits);
    expect(text).toContain("lab");
    for (const line of secretLines()) expect(text).not.toContain(line);
  });

  test("the logs written while credentials were in use name no credential", () => {
    expect(logged.length).toBeGreaterThan(0);
    const text = logged.join("\n");
    for (const line of secretLines()) expect(text).not.toContain(line);
    expect(text).not.toContain("PRIVATE KEY");
  });
});
