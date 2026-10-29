/**
 * An agent host against a real Docker engine. The control plane issues a pairing code, an agent spends it and dials in
 * over a real WebSocket, and a box created on that host is a real container that runs through the agent. The agent and
 * the control plane share one engine here, so the recorded calls show which path each operation took.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-agent.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";
import Docker from "dockerode";

import { AgentClient } from "../src/agent/client";
import { generateKeyPairPem, loadIdentity, type StoredIdentity, saveIdentity } from "../src/agent/identity";
import { pairWith } from "../src/agent/main";
import { AGENT_PROTOCOL } from "../src/agent/protocol";
import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import { labelKeys } from "../src/labels";
import type { Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { TEST_KEY, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const AGENT_VERSION = "0.4.0";
const keys = labelKeys(prefix);
const docker = new Docker({ socketPath: SOCKET });

let app: App;
let server: Server<SocketData>;
let base: string;
let client: AgentClient | null = null;
let clientDone: Promise<void> | null = null;
let stored: StoredIdentity | null = null;
const agentCalls: string[] = [];
const dirs: string[] = [];

interface BoxJson {
  id: string;
  name: string;
  hostId?: string;
}

/** The engine runtime with every operation recorded, so a test can see which calls the agent ran. */
function recording(runtime: Runtime, calls: string[]): Runtime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return value.apply(target, args);
      };
    },
  });
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function containersNamed(name: string) {
  return docker.listContainers({
    all: true,
    filters: { label: [`${keys.box}=true`, `${keys.name}=${name}`] },
  });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = LONG): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const dataDir = mkdtempSync(join(tmpdir(), "minibox-agent-test-"));
  dirs.push(dataDir);
  const cfg = testConfig({
    labelPrefix: prefix,
    dockerSocket: SOCKET,
    baseTemplateTag: `${prefix}-template:base`,
    dataDir,
  });
  app = createApp(cfg, "0.0.0-test", { runtime: createDockerRuntime(SOCKET), eventsPath: ":memory:" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
}, LONG);

afterAll(async () => {
  if (!enabled) return;
  client?.stop();
  await clientDone;
  app?.hostAdmin.close();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.events.close();
  server?.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const container of await containersNamed("agent-box")) {
    await docker
      .getContainer(container.Id)
      .remove({ force: true })
      .catch(() => {});
  }
}, LONG);

describe.skipIf(!enabled)("an agent host, against a real engine", () => {
  let boxId = "";

  test(
    "an agent spends a pairing code, dials in, and its host goes online with the engine's version",
    async () => {
      const issued = await post("/api/hosts/pairing", { id: "edge", name: "Edge engine" });
      expect(issued.status).toBe(201);
      const { code } = (await issued.json()) as { code: string };

      const keys = generateKeyPairPem();
      const reply = await pairWith(base, {
        code,
        publicKey: keys.publicKeyPem,
        version: AGENT_VERSION,
        protocol: AGENT_PROTOCOL,
      });
      const dir = mkdtempSync(join(tmpdir(), "minibox-agent-edge-"));
      dirs.push(dir);
      saveIdentity(
        dir,
        { agentId: reply.agentId, hostId: reply.hostId, server: base, pairedAt: new Date().toISOString() },
        keys.privateKeyPem,
      );
      stored = loadIdentity(dir);
      if (!stored) throw new Error("the identity was not saved");

      client = new AgentClient({
        server: base,
        agentId: stored.identity.agentId,
        privateKey: stored.privateKey,
        runtime: recording(createDockerRuntime(SOCKET), agentCalls),
        version: AGENT_VERSION,
      });
      clientDone = client.run();

      // Online comes from the link, and the engine's version from the check the connection starts, so the version is
      // waited for as well: a read in between sees an online host that has not been asked yet.
      await waitFor(
        () => typeof app.hostAdmin.list().find((host) => host.id === "edge")?.dockerVersion === "string",
        "the agent host to go online with the engine's version",
      );
      const hosts = (await (await api("/api/hosts")).json()) as { hosts: Array<Record<string, unknown>> };
      const version = await docker.version();
      expect(hosts.hosts.find((host) => host.id === "edge")).toMatchObject({
        transport: "agent",
        status: "online",
        dockerVersion: version.Version,
        agent: { connected: true, version: AGENT_VERSION, upgradeRequired: false, revoked: false },
      });
    },
    LONG,
  );

  test(
    "a box created on the agent host is a real container, and the agent ran its create",
    async () => {
      const made = await post("/api/boxes", {
        name: "agent-box",
        template: IMAGE,
        cpus: 0.5,
        memoryMb: 128,
        mounts: [],
        host: "edge",
      });
      expect(made.status).toBe(201);
      const { box } = (await made.json()) as { box: BoxJson };
      expect(box).toMatchObject({ name: "agent-box", hostId: "edge" });
      boxId = box.id;

      const containers = await containersNamed("agent-box");
      expect(containers).toHaveLength(1);
      expect(containers[0]?.State).toBe("running");
      expect(agentCalls).toContain("createContainer");
    },
    LONG,
  );

  test(
    "a command in the box runs through the agent and returns its output and exit code",
    async () => {
      const res = await post(`/api/boxes/${boxId}/exec`, {
        cmd: "echo agent-$((40 + 2)); echo to-stderr >&2; exit 3",
        user: "root",
        cwd: "/",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ exitCode: 3, stdout: "agent-42\n", stderr: "to-stderr\n" });
      expect(agentCalls).toContain("startExec");
    },
    LONG,
  );

  test(
    "revoking the agent drops it at once: its box stays on the engine, and a command on it is refused",
    async () => {
      const revoked = await api("/api/hosts/edge/revoke", { method: "POST" });
      expect(revoked.status).toBe(200);
      await waitFor(() => client?.connectionState === "dormant", "the agent to go dormant", 10_000);
      expect(app.hosts.get("edge").host.status).toBe("offline");

      expect((await containersNamed("agent-box")).length).toBe(1);
      const res = await post(`/api/boxes/${boxId}/exec`, { cmd: "true", user: "root", cwd: "/" });
      expect(res.status).not.toBe(200);
    },
    LONG,
  );
});
