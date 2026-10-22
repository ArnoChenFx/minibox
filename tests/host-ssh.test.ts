import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { hostsPath } from "../src/data-dir";
import { openLink } from "../src/host/link";
import { HostKeyMismatchError } from "../src/host/ssh";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import {
  type FakeEngine,
  type FakeSshHost,
  type KeyPair,
  newKeyPair,
  removeDir,
  startFakeEngine,
  startSshHost,
  tempDir,
} from "./support/engines";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const GIB = 1024 ** 3;

let app: App;
let server: Server<SocketData>;
let base: string;
let engine: FakeEngine;
let sshHost: FakeSshHost;
let trusted: KeyPair;
let stranger: KeyPair;
let dir: string;
let restoreLogs: () => void;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const endpointOf = (port: number) => `ssh://minibox@127.0.0.1:${port}${engine.socketPath}`;

type ErrorBody = { code: string; key?: string; details?: Record<string, unknown> };

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

beforeAll(async () => {
  restoreLogs = silenceLogs();
  dir = tempDir("mbt-ssh-");
  trusted = newKeyPair();
  stranger = newKeyPair();
  engine = startFakeEngine(dir, { cpus: 4, memoryBytes: 8 * GIB, version: "27.0.0-fake" });
  sshHost = await startSshHost(trusted, engine.socketPath);
  const cfg = testConfig({ labelPrefix: "mbtest" });
  const local = new FakeRuntime();
  app = createApp(cfg, "0.0.0-test", {
    runtime: local,
    checkpointEngine: new FakeCheckpointEngine(local),
    eventsPath: ":memory:",
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  app.events.close();
  server.stop(true);
  await sshHost.close();
  engine.stop();
  removeDir(dir);
  restoreLogs();
});

describe("an SSH host, added with the OpenSSH key it presents", () => {
  test("a host whose key was not confirmed is refused with the key it presented, before any login", async () => {
    const res = await api("/api/hosts", {
      method: "POST",
      body: JSON.stringify({ id: "edge", endpoint: endpointOf(sshHost.port), privateKey: trusted.privateKey }),
    });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "conflict", key: "host_key_unconfirmed" });
    expect(error.details).toEqual({ fingerprint: sshHost.fingerprint });
    expect(sshHost.authAttempts).toEqual([]);
    expect(engine.requests).toEqual([]);
    expect(existsSync(hostsPath(app.cfg.dataDir))).toBe(false);
  });

  test("a confirmed fingerprint that the host does not present is refused before the login", async () => {
    const res = await api("/api/hosts", {
      method: "POST",
      body: JSON.stringify({
        id: "edge",
        endpoint: endpointOf(sshHost.port),
        privateKey: trusted.privateKey,
        hostKeyFingerprint: "SHA256:not-the-host-key",
      }),
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "conflict", key: "host_key_mismatch" });
    expect(sshHost.authAttempts).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  test("a test reports the presented key and the engine's capacity, and saves nothing", async () => {
    const res = await api("/api/hosts/test", {
      method: "POST",
      body: JSON.stringify({
        id: "edge",
        endpoint: endpointOf(sshHost.port),
        privateKey: trusted.privateKey,
        hostKeyFingerprint: sshHost.fingerprint,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      status: "online",
      hostKeyFingerprint: sshHost.fingerprint,
      capacity: { cpus: 4, memoryBytes: 8 * GIB },
      dockerVersion: "27.0.0-fake",
      error: null,
    });
    expect(sshHost.forwards).toContain(engine.socketPath);
    expect(existsSync(hostsPath(app.cfg.dataDir))).toBe(false);
  });

  test("a key the host does not authorise is refused, and the host is not added", async () => {
    const before = sshHost.authAttempts.length;
    const res = await api("/api/hosts", {
      method: "POST",
      body: JSON.stringify({
        id: "edge",
        endpoint: endpointOf(sshHost.port),
        privateKey: stranger.privateKey,
        hostKeyFingerprint: sshHost.fingerprint,
      }),
    });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: "docker_unavailable" });
    const attempts = sshHost.authAttempts.slice(before);
    expect(attempts.length).toBeGreaterThan(0);
    expect(new Set(attempts)).toEqual(new Set(["minibox"]));
    expect(app.hosts.has("edge")).toBe(false);
    expect(existsSync(join(app.cfg.dataDir, "hosts", "edge"))).toBe(false);
  });

  test("a confirmed host is added, reports online with its capacity, and its key is stored on the control plane only", async () => {
    const res = await api("/api/hosts", {
      method: "POST",
      body: JSON.stringify({
        id: "edge",
        name: "Edge",
        endpoint: endpointOf(sshHost.port),
        privateKey: trusted.privateKey,
        hostKeyFingerprint: sshHost.fingerprint,
      }),
    });
    expect(res.status).toBe(201);
    const { host } = (await res.json()) as { host: Record<string, unknown> };
    expect(host).toMatchObject({
      id: "edge",
      name: "Edge",
      transport: "ssh",
      status: "online",
      capacity: { cpus: 4, memoryBytes: 8 * GIB },
      dockerVersion: "27.0.0-fake",
      boxes: 0,
    });
    expect(JSON.stringify(host)).not.toContain("PRIVATE KEY");
    expect(app.hosts.get("edge").host.status).toBe("online");
    expect(sshHost.forwards.filter((path) => path === engine.socketPath).length).toBeGreaterThan(0);
    expect(engine.requests).toEqual(expect.arrayContaining(["GET /_ping", "GET /info", "GET /version"]));
  });

  test("the hosts file names the host and its key fingerprint, but holds no key material", () => {
    const path = hostsPath(app.cfg.dataDir);
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as { version: number; hosts: Record<string, unknown>[] };
    expect(parsed.version).toBe(1);
    expect(parsed.hosts).toEqual([
      expect.objectContaining({
        id: "edge",
        name: "Edge",
        endpoint: `ssh://minibox@127.0.0.1:${sshHost.port}${engine.socketPath}`,
        hostKeyFingerprint: sshHost.fingerprint,
      }),
    ]);
    expect(text).not.toContain("PRIVATE KEY");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the private key is a credential file readable by its owner only", () => {
    const file = join(app.cfg.dataDir, "hosts", "edge", "ssh_key");
    expect(readFileSync(file, "utf8")).toBe(`${trusted.privateKey}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("the list shows the host without its key, and an unknown host's list is still served", async () => {
    const res = await api("/api/hosts");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("PRIVATE KEY");
    const { hosts } = JSON.parse(text) as { hosts: { id: string; status: string }[] };
    expect(hosts.map((host) => [host.id, host.status])).toEqual([
      ["local", "unknown"],
      ["edge", "online"],
    ]);
  });

  test("a link to a host that presents a different key is refused, and no login is attempted", async () => {
    const before = sshHost.authAttempts.length;
    const link = openLink(
      { kind: "ssh", user: "minibox", hostname: "127.0.0.1", port: sshHost.port, socketPath: engine.socketPath },
      { ssh: { privateKey: trusted.privateKey, hostKeyFingerprint: "SHA256:pinned-to-another-host" } },
    );
    try {
      await expect(link.connect()).rejects.toBeInstanceOf(HostKeyMismatchError);
    } finally {
      link.close();
    }
    expect(sshHost.authAttempts.length).toBe(before);
  });

  test("removing the host deletes its credentials and drops it from the hosts file", async () => {
    const res = await api("/api/hosts/edge", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(app.hosts.has("edge")).toBe(false);
    expect(existsSync(join(app.cfg.dataDir, "hosts", "edge"))).toBe(false);
    const parsed = JSON.parse(readFileSync(hostsPath(app.cfg.dataDir), "utf8")) as { hosts: unknown[] };
    expect(parsed.hosts).toEqual([]);
  });
});
