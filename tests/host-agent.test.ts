import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { AgentClient } from "../src/agent/client";
import { generateKeyPairPem, loadIdentity, type StoredIdentity, saveIdentity } from "../src/agent/identity";
import { pairWith } from "../src/agent/main";
import { AGENT_CLOSE, AGENT_PAIR_PATH, AGENT_PROTOCOL, signHello } from "../src/agent/protocol";
import { type App, createApp } from "../src/app";
import { agentsPath } from "../src/data-dir";
import { normalizeCode, PairingBook } from "../src/host/agent/pairing";
import { AgentStore, AgentsFileError } from "../src/host/agent/store";
import { AppError } from "../src/lib/errors";
import { msg } from "../src/lib/messages";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const AGENT_VERSION = "0.4.0";
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
const GIB = 1024 ** 3;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minibox-agent-host-"));
  dirs.push(dir);
  return dir;
}

function pairingKey(): string {
  return generateKeyPairPem().publicKeyPem;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** One 1,200-byte log line, numbered so the first and last kept can be told apart. */
const logLine = (i: number) => `${String(i).padStart(6, "0")} ${"x".repeat(1_192)}\n`;

describe("pairing codes", () => {
  test("a typed code is read the way it was meant: case, spaces, dashes and look-alike letters do not matter", () => {
    expect(normalizeCode("ab12c-d3fO")).toBe("AB12CD3F0");
    expect(normalizeCode(" ab12c d3f0 ")).toBe("AB12CD3F0");
    expect(normalizeCode("I1L")).toBe("111");
  });

  test("a code can be spent once, and a second spend is refused as used", () => {
    const book = new PairingBook();
    const { code } = book.create("edge", "Edge");
    expect(book.redeem(code)).toEqual({ hostId: "edge", name: "Edge" });
    expect(() => book.redeem(code)).toThrow(AppError);
    expect(() => book.redeem(code)).toThrow(msg("agent_pairing_used").text);
  });

  test("an expired code is refused as expired, and an unknown code as unknown", () => {
    let now = 1_000_000;
    const book = new PairingBook(60_000, 50, () => now);
    const { code } = book.create("edge", "Edge");
    expect(() => book.redeem("ZZZZZ-ZZZZZ")).toThrow(msg("agent_pairing_unknown").text);
    now += 60_000;
    expect(() => book.redeem(code)).toThrow(msg("agent_pairing_expired").text);
  });

  test("codes waiting to be used are capped, and a spent code no longer counts against the cap", () => {
    const book = new PairingBook(60_000, 2);
    const first = book.create("a", "A");
    book.create("b", "B");
    let refused: unknown;
    try {
      book.create("c", "C");
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).status).toBe(429);
    book.redeem(first.code);
    expect(() => book.create("c", "C")).not.toThrow();
  });

  test("a code is issued in the shape the operator types: two groups of five", () => {
    expect(new PairingBook().create("edge", "Edge").code).toMatch(CODE_PATTERN);
  });
});

describe("the agents file", () => {
  test("the file is private and holds the public key only, never a private key", () => {
    const dir = tempDir();
    const store = new AgentStore(dir);
    store.put({
      agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c",
      hostId: "edge",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAx\n-----END PUBLIC KEY-----",
      version: AGENT_VERSION,
      protocol: AGENT_PROTOCOL,
      pairedAt: "2026-10-22T00:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(statSync(agentsPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(agentsPath(dir), "utf8")).not.toContain("PRIVATE");
    expect(new AgentStore(dir).get("9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c")?.hostId).toBe("edge");
  });

  test("a corrupt agents file is refused, and the message names the file so the operator can fix it", () => {
    const dir = tempDir();
    writeFileSync(agentsPath(dir), "{not json", { mode: 0o600 });
    expect(() => new AgentStore(dir)).toThrow(AgentsFileError);
    expect(() => new AgentStore(dir)).toThrow(/agents\.json is not valid JSON/);
  });

  test("a failed write leaves the records as they were, and the error is raised", () => {
    const store = new AgentStore(join(tempDir(), "not-there"));
    const agentId = "1".repeat(32);
    expect(() =>
      store.put({
        agentId,
        hostId: "edge",
        publicKeyPem: "k",
        version: AGENT_VERSION,
        protocol: AGENT_PROTOCOL,
        pairedAt: "2026-10-22T00:00:00.000Z",
        lastSeenAt: null,
        revokedAt: null,
      }),
    ).toThrow();
    expect(store.get(agentId)).toBeUndefined();
  });
});

describe("the control plane's agent API, over HTTP and a real socket", () => {
  let app: App;
  let server: Server<SocketData>;
  let base: string;
  let local: FakeRuntime;
  let edgeEngine: FakeRuntime;
  let restoreLogs: () => void;
  const agents: Array<{ client: AgentClient; done: Promise<void> }> = [];

  function api(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${TEST_KEY}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return fetch(`${base}${path}`, { ...init, headers });
  }

  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

  async function pairWithCode(code: string, publicKey: string, protocol = AGENT_PROTOCOL) {
    return fetch(`${base}${AGENT_PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, publicKey, version: AGENT_VERSION, protocol }),
    });
  }

  /** Pairs a new agent with `code` the way `bun src/agent/main.ts --pair` does, and keeps its identity in `dir`. */
  async function enrollAgent(code: string, dir: string): Promise<StoredIdentity> {
    const keys = generateKeyPairPem();
    const reply = await pairWith(base, {
      code,
      publicKey: keys.publicKeyPem,
      version: AGENT_VERSION,
      protocol: AGENT_PROTOCOL,
    });
    saveIdentity(
      dir,
      { agentId: reply.agentId, hostId: reply.hostId, server: base, pairedAt: new Date().toISOString() },
      keys.privateKeyPem,
    );
    const stored = loadIdentity(dir);
    if (!stored) throw new Error("the identity was not saved");
    return stored;
  }

  function runAgent(stored: StoredIdentity, runtime: FakeRuntime): AgentClient {
    const client = new AgentClient({
      server: base,
      agentId: stored.identity.agentId,
      privateKey: stored.privateKey,
      runtime,
      version: AGENT_VERSION,
      minBackoffMs: 10,
      maxBackoffMs: 50,
    });
    agents.push({ client, done: client.run() });
    return client;
  }

  beforeEach(() => {
    restoreLogs = silenceLogs();
    local = new FakeRuntime();
    edgeEngine = new FakeRuntime();
    edgeEngine.engine = { cpus: 2, memoryBytes: 4 * GIB };
    app = createApp(testConfig({ labelPrefix: "mbtest", dataDir: tempDir() }), "0.0.0-test", {
      runtime: local,
      connect: () => new FakeRuntime(),
      checkpointEngine: new FakeCheckpointEngine(),
      eventsPath: ":memory:",
    });
    const keys = app.hosts.get().keys;
    for (const runtime of [local, edgeEngine]) {
      runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    }
    server = startServer(app);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    for (const { client, done } of agents.splice(0)) {
      client.stop();
      await done;
    }
    app.hostAdmin.close();
    app.sessions.stop();
    app.tokens.stop();
    app.events.close();
    server.stop(true);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    restoreLogs();
  });

  test("an operator issues a code, the agent pairs with it once, and the host is listed as an agent host", async () => {
    const issued = await post("/api/hosts/pairing", { id: "edge", name: "Edge lab" });
    expect(issued.status).toBe(201);
    const pairing = (await issued.json()) as { id: string; name: string; code: string; expiresAt: string };
    expect(pairing).toMatchObject({ id: "edge", name: "Edge lab" });
    expect(pairing.code).toMatch(CODE_PATTERN);
    expect(Date.parse(pairing.expiresAt)).toBeGreaterThan(Date.now());

    const paired = await pairWithCode(pairing.code, pairingKey());
    expect(paired.status).toBe(201);
    const reply = (await paired.json()) as { agentId: string; hostId: string; protocol: number };
    expect(reply).toEqual({
      agentId: expect.stringMatching(/^[0-9a-f]{32}$/),
      hostId: "edge",
      protocol: AGENT_PROTOCOL,
    });

    const hosts = (await (await api("/api/hosts")).json()) as { hosts: Array<Record<string, unknown>> };
    expect(hosts.hosts.find((host) => host.id === "edge")).toMatchObject({
      id: "edge",
      name: "Edge lab",
      transport: "agent",
      endpoint: `agent://${reply.agentId}`,
      agent: {
        connected: false,
        version: AGENT_VERSION,
        protocol: AGENT_PROTOCOL,
        upgradeRequired: false,
        revoked: false,
      },
    });
  });

  test("a spent code is refused as used, an unknown code as unknown, and a bad key is refused without spending the code", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };

    const badKey = await pairWithCode(code, "not a key");
    expect(badKey.status).toBe(400);

    const first = await pairWithCode(code, pairingKey());
    expect(first.status).toBe(201);

    const reused = await pairWithCode(code, pairingKey());
    expect(reused.status).toBe(401);
    expect(((await reused.json()) as { error: { message: string } }).error.message).toBe(
      msg("agent_pairing_used").text,
    );

    const unknown = await pairWithCode("ZZZZZ-ZZZZZ", pairingKey());
    expect(unknown.status).toBe(401);
  });

  test("an agent on another protocol gets a conflict, and the code still works once it is upgraded", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };
    const older = await pairWithCode(code, pairingKey(), AGENT_PROTOCOL + 1);
    expect(older.status).toBe(409);
    const upgraded = await pairWithCode(code, pairingKey());
    expect(upgraded.status).toBe(201);
  });

  test("a host id that is taken cannot be issued a code", async () => {
    const res = await post("/api/hosts/pairing", { id: "local" });
    expect(res.status).toBe(409);
  });

  test("an agent dials in, the host goes online, and a box created on it runs on the agent's engine", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge", name: "Edge" })).json()) as {
      code: string;
    };
    const dir = tempDir();
    const stored = await enrollAgent(code, dir);
    runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");
    await waitFor(() => app.hosts.get("edge").host.status === "online", "the host to go online");

    const made = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256, host: "edge" });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { box: { hostId: string } }).box.hostId).toBe("edge");
    expect(edgeEngine.callsTo("createContainer")).toHaveLength(1);
    expect(local.callsTo("createContainer")).toHaveLength(0);

    const hosts = (await (await api("/api/hosts")).json()) as { hosts: Array<Record<string, unknown>> };
    expect(hosts.hosts.find((host) => host.id === "edge")).toMatchObject({
      status: "online",
      agent: { connected: true, version: AGENT_VERSION },
    });
  });

  test("a log read past 4 MiB comes back over the agent's socket in one frame, and the agent stays connected", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge", name: "Edge" })).json()) as {
      code: string;
    };
    const stored = await enrollAgent(code, tempDir());
    runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");
    await waitFor(() => app.hosts.get("edge").host.status === "online", "the host to go online");
    const made = await post("/api/boxes", { name: "chatty", cpus: 1, memoryMb: 256, host: "edge" });
    expect(made.status).toBe(201);
    const box = ((await made.json()) as { box: { id: string } }).box;

    // 5,000 lines of 1,200 bytes: about 6 MiB, past the 4 MiB a frame was once held to, in one `containerLogs` answer.
    edgeEngine.appendLogs(box.id, Array.from({ length: 5_000 }, (_, i) => logLine(i)).join(""));
    const read = await api(`/api/boxes/chatty/logs?tail=5000`);
    expect(read.status).toBe(200);
    const { logs } = (await read.json()) as { logs: string };
    expect(Buffer.byteLength(logs)).toBeGreaterThan(4 * 1024 * 1024);
    expect(logs.startsWith(logLine(0))).toBe(true);
    expect(logs.endsWith(logLine(4_999))).toBe(true);

    // The same socket answers the next call: the large frame did not close it.
    expect(app.agents.status(stored.identity.agentId)?.connected).toBe(true);
    expect((await api(`/api/boxes/chatty/logs?tail=1`)).status).toBe(200);
  });

  test("a revoked agent is dropped at once, cannot dial in again, and its host is offline", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };
    const dir = tempDir();
    const stored = await enrollAgent(code, dir);
    const client = runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");

    const revoked = await api("/api/hosts/edge/revoke", { method: "POST" });
    expect(revoked.status).toBe(200);
    await waitFor(() => client.connectionState === "dormant", "the agent to go dormant");
    expect(app.agents.status(stored.identity.agentId)).toMatchObject({ connected: false, revoked: true });
    expect(app.hosts.get("edge").host.status).toBe("offline");

    const again = new WebSocket(`ws://127.0.0.1:${server.port}/api/agent/connect`);
    const closed = new Promise<CloseEvent>((resolve) => again.addEventListener("close", resolve));
    again.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; nonce?: string };
      if (frame.type !== "challenge" || frame.nonce === undefined) return;
      again.send(
        JSON.stringify({
          type: "hello",
          agentId: stored.identity.agentId,
          protocol: AGENT_PROTOCOL,
          version: AGENT_VERSION,
          signature: signHello(stored.privateKey, frame.nonce, stored.identity.agentId, AGENT_PROTOCOL),
        }),
      );
    });
    expect((await closed).code).toBe(AGENT_CLOSE.revoked);

    const onRevoked = await post("/api/boxes", { name: "beta", cpus: 1, memoryMb: 256, host: "edge" });
    expect(onRevoked.status).not.toBe(201);
    expect(edgeEngine.callsTo("createContainer")).toHaveLength(0);
  });

  test("revoking a host that is not an agent is refused", async () => {
    const res = await api("/api/hosts/local/revoke", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("removing an agent host forgets its agent, so the agent cannot connect again", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };
    const dir = tempDir();
    const stored = await enrollAgent(code, dir);
    runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");

    const removed = await api("/api/hosts/edge", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(app.agents.record(stored.identity.agentId)).toBeUndefined();
    expect(app.agents.status(stored.identity.agentId)).toBeNull();
    const hosts = (await (await api("/api/hosts")).json()) as { hosts: Array<{ id: string }> };
    expect(hosts.hosts.map((host) => host.id)).not.toContain("edge");
  });

  test("a box cannot be moved to or from an agent host, which is refused as unsupported", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };
    const dir = tempDir();
    const stored = await enrollAgent(code, dir);
    runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");

    const made = await post("/api/boxes", { name: "gamma", cpus: 1, memoryMb: 256 });
    expect(made.status).toBe(201);
    const box = ((await made.json()) as { box: { id: string; revision: number } }).box;
    const moved = await api(`/api/boxes/${box.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": String(box.revision) },
      body: JSON.stringify({ host: "edge" }),
    });
    expect(moved.status).toBe(501);
    expect(((await moved.json()) as { error: { code: string } }).error.code).toBe("unsupported");
  });

  test("templates, snapshots and image pulls stay off an agent host, which refuses them as unsupported", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };
    const stored = await enrollAgent(code, tempDir());
    runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");

    const made = await post("/api/boxes", { name: "delta", cpus: 1, memoryMb: 256, host: "edge" });
    expect(made.status).toBe(201);
    const { boxId } = ((await made.json()) as { box: { boxId: string } }).box;
    const refusals = [
      await post(`/api/boxes/${boxId}/snapshots`, {}),
      await post(`/api/boxes/${boxId}/template`, { name: "delta-tpl" }),
      await post("/api/images/pull", { ref: "alpine:3.20", host: "edge" }),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: { code: string; key: string } }).error).toMatchObject({
        code: "unsupported",
        key: "agent_host_unsupported",
      });
    }
    expect(edgeEngine.callsTo("commitContainer")).toHaveLength(0);
  });

  test("a box with a self token is refused on an agent host, which cannot write the token file, and nothing is created", async () => {
    const { code } = (await (await post("/api/hosts/pairing", { id: "edge" })).json()) as { code: string };
    const stored = await enrollAgent(code, tempDir());
    runAgent(stored, edgeEngine);
    await waitFor(() => app.agents.status(stored.identity.agentId)?.connected === true, "the agent to connect");

    const refused = await post("/api/boxes", {
      name: "epsilon",
      cpus: 1,
      memoryMb: 256,
      host: "edge",
      selfToken: true,
    });
    expect(refused.status).toBe(501);
    expect(((await refused.json()) as { error: { code: string; key: string } }).error).toMatchObject({
      code: "unsupported",
      key: "self_token_host_unsupported",
    });
    expect(edgeEngine.callsTo("createContainer")).toHaveLength(0);
    expect(app.hosts.get("edge").specs.findByName("epsilon")).toBeNull();
  });
});
