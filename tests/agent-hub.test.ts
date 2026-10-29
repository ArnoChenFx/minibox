import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CLOSE, AGENT_PROTOCOL, type ExecExit, signHello } from "../src/agent/protocol";
import { type AgentEvent, AgentHub, type AgentSession, type AgentSocket } from "../src/host/agent/hub";
import { PairingBook } from "../src/host/agent/pairing";
import { AgentStore } from "../src/host/agent/store";
import { RuntimeError } from "../src/runtime";

const AGENT_VERSION = "0.4.0";

/** A socket that records what the hub sends it and how it is closed. */
interface FakeSocket extends AgentSocket {
  readonly sent: Array<Record<string, unknown>>;
  readonly closed: Array<{ code: number; reason: string }>;
}

function fakeSocket(): FakeSocket {
  const sent: Array<Record<string, unknown>> = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return {
    sent,
    closed,
    send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
    close: (code, reason) => closed.push({ code, reason }),
  };
}

const framesOf = (socket: FakeSocket, type: string) => socket.sent.filter((frame) => frame.type === type);
const nonceOf = (socket: FakeSocket) => String(framesOf(socket, "challenge")[0]?.nonce);

const dirs: string[] = [];
const hubs: AgentHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { labelPrefix?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "minibox-hub-test-"));
  dirs.push(dataDir);
  const store = new AgentStore(dataDir);
  const hub = new AgentHub({ store, pairing: new PairingBook(), serverVersion: "0.4.0-test", ...options });
  hubs.push(hub);
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const enroll = () =>
    hub.enroll({
      hostId: "edge",
      publicKeyPem,
      version: AGENT_VERSION,
      protocol: AGENT_PROTOCOL,
      pairedAt: "2026-10-22T00:00:00.000Z",
    });
  return { hub, store, enroll, key: pair.privateKey };
}

function helloFrame(key: KeyObject, nonce: string, agentId: string, protocol = AGENT_PROTOCOL): string {
  return JSON.stringify({
    type: "hello",
    agentId,
    protocol,
    version: AGENT_VERSION,
    signature: signHello(key, nonce, agentId, protocol),
  });
}

/** Opens a socket and answers its challenge with a hello. Returns the socket and the hub's end of it. */
function connect(hub: AgentHub, key: KeyObject, agentId: string, protocol = AGENT_PROTOCOL) {
  const socket = fakeSocket();
  const session: AgentSession = hub.attach(socket, "10.0.0.1");
  session.receive(helloFrame(key, nonceOf(socket), agentId, protocol));
  return { socket, session };
}

describe("the handshake", () => {
  test("a socket is challenged as it opens, and a valid hello is welcomed and marks the agent connected", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const events: AgentEvent[] = [];
    hub.subscribe((event) => events.push(event));
    const socket = fakeSocket();
    const session = hub.attach(socket, "10.0.0.1");
    expect(framesOf(socket, "challenge")[0]).toMatchObject({ protocol: AGENT_PROTOCOL, serverVersion: "0.4.0-test" });
    session.receive(helloFrame(key, nonceOf(socket), record.agentId));
    expect(framesOf(socket, "welcome")).toEqual([{ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL }]);
    expect(hub.status(record.agentId)).toMatchObject({
      connected: true,
      version: AGENT_VERSION,
      upgradeRequired: false,
      revoked: false,
    });
    expect(events).toEqual([{ type: "connected", agentId: record.agentId }]);
  });

  test("the welcome names the control plane's label prefix when it has one, and says nothing of it when it has none", () => {
    const named = setup({ labelPrefix: "minibox" });
    const record = named.enroll();
    const socket = fakeSocket();
    const session = named.hub.attach(socket, "10.0.0.1");
    session.receive(helloFrame(named.key, nonceOf(socket), record.agentId));
    expect(framesOf(socket, "welcome")).toEqual([
      { type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL, labelPrefix: "minibox" },
    ]);

    // A control plane that predates the field sends a welcome without it, which an agent reads as "nothing to adopt by".
    const bare = setup();
    const bareRecord = bare.enroll();
    const bareSocket = fakeSocket();
    const bareSession = bare.hub.attach(bareSocket, "10.0.0.1");
    bareSession.receive(helloFrame(bare.key, nonceOf(bareSocket), bareRecord.agentId));
    expect(framesOf(bareSocket, "welcome")[0]).not.toHaveProperty("labelPrefix");
  });

  test("a hello signed by another key is refused as auth_failed, and the socket is closed 4401", () => {
    const { hub, enroll } = setup();
    const record = enroll();
    const stranger = generateKeyPairSync("ed25519").privateKey;
    const socket = fakeSocket();
    hub.attach(socket, "10.0.0.1").receive(helloFrame(stranger, nonceOf(socket), record.agentId));
    expect(framesOf(socket, "refused")).toEqual([
      { type: "refused", code: "auth_failed", message: expect.any(String) },
    ]);
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.authFailed, reason: "auth failed" }]);
    expect(hub.status(record.agentId)?.connected).toBe(false);
  });

  test("an agent id the control plane does not know is refused the same way", () => {
    const { hub, key } = setup();
    const socket = fakeSocket();
    hub.attach(socket, "10.0.0.1").receive(helloFrame(key, nonceOf(socket), "f".repeat(32)));
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.authFailed, reason: "auth failed" }]);
  });

  test("a revoked agent is refused 4403 even with a valid signature", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    hub.revoke(record.agentId);
    const { socket } = connect(hub, key, record.agentId);
    expect(framesOf(socket, "refused")).toEqual([{ type: "refused", code: "revoked", message: expect.any(String) }]);
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.revoked, reason: "revoked" }]);
    expect(hub.status(record.agentId)).toMatchObject({ connected: false, revoked: true });
  });

  test("an agent on another protocol is refused 4426, and its version is kept so the console can ask for an upgrade", () => {
    const { hub, enroll, key, store } = setup();
    const record = enroll();
    const { socket } = connect(hub, key, record.agentId, AGENT_PROTOCOL + 1);
    expect(framesOf(socket, "refused")).toEqual([
      { type: "refused", code: "protocol_mismatch", message: expect.stringContaining(String(AGENT_PROTOCOL)) },
    ]);
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.protocolMismatch, reason: "protocol mismatch" }]);
    expect(store.get(record.agentId)?.protocol).toBe(AGENT_PROTOCOL + 1);
    expect(hub.status(record.agentId)).toMatchObject({ connected: false, upgradeRequired: true });
  });

  test("a second connection for the same agent replaces the first, which is closed 4409", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const first = connect(hub, key, record.agentId);
    connect(hub, key, record.agentId);
    expect(first.socket.closed).toEqual([{ code: AGENT_CLOSE.replaced, reason: "replaced by a newer connection" }]);
    expect(hub.status(record.agentId)?.connected).toBe(true);
  });

  test("frames before a hello are ignored, and a repeated hello is ignored too", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const socket = fakeSocket();
    const session = hub.attach(socket, "10.0.0.1");
    session.receive(JSON.stringify({ type: "response", id: "x", ok: true, result: {} }));
    expect(socket.closed).toEqual([]);
    const hello = helloFrame(key, nonceOf(socket), record.agentId);
    session.receive(hello);
    session.receive(hello);
    expect(framesOf(socket, "welcome")).toHaveLength(1);
  });

  test("a status for an agent that was never paired is null", () => {
    const { hub } = setup();
    expect(hub.status("0".repeat(32))).toBeNull();
  });
});

describe("requests over the connection", () => {
  test("a request is sent to the live connection and resolves with the agent's answer", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const pending = hub.request(record.agentId, "info", {}, { timeoutMs: 1000 });
    const sent = framesOf(socket, "request")[0];
    expect(sent).toMatchObject({ type: "request", op: "info", args: {} });
    session.receive(JSON.stringify({ type: "response", id: sent?.id, ok: true, result: { version: "29" } }));
    await expect(pending).resolves.toEqual({ version: "29" });
  });

  test("a request to an agent that is not connected fails as unavailable, and nothing is sent", async () => {
    const { hub, enroll } = setup();
    const record = enroll();
    await expect(hub.request(record.agentId, "ping", {}, { timeoutMs: 1000 })).rejects.toMatchObject({
      kind: "unavailable",
      message: "the agent is not connected",
    });
  });

  test("a request the agent does not answer in time fails as unavailable", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    connect(hub, key, record.agentId);
    const failure = hub.request(record.agentId, "ping", {}, { timeoutMs: 15 });
    await expect(failure).rejects.toBeInstanceOf(RuntimeError);
    await expect(failure).rejects.toMatchObject({
      kind: "unavailable",
      message: "the agent did not answer within 15 ms",
    });
  });

  test("a call still waiting when its agent disconnects fails as unavailable, and the last time it was seen is kept", async () => {
    const { hub, enroll, key, store } = setup();
    const record = enroll();
    const { session } = connect(hub, key, record.agentId);
    const pending = hub.request(record.agentId, "listVolumes", {}, { timeoutMs: 1000 });
    session.detach();
    await expect(pending).rejects.toMatchObject({ kind: "unavailable", message: "the agent disconnected" });
    expect(hub.status(record.agentId)?.connected).toBe(false);
    expect(store.get(record.agentId)?.lastSeenAt).toBeString();
  });

  test("an error the agent reports keeps its kind and message", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const pending = hub.request(record.agentId, "inspectContainer", { id: "bx_gone" }, { timeoutMs: 1000 });
    session.receive(
      JSON.stringify({
        type: "response",
        id: framesOf(socket, "request")[0]?.id,
        ok: false,
        error: { kind: "not_found", message: "no such box", detail: "bx_gone" },
      }),
    );
    await expect(pending).rejects.toMatchObject({ kind: "not_found", message: "no such box" });
  });
});

describe("streams over the connection", () => {
  for (const payload of ["line", "x".repeat(128 * 1024)]) {
    test(`a slow log consumer is cancelled with an explicit error (${payload.length} bytes per item)`, async () => {
      const { hub, enroll, key } = setup();
      const record = enroll();
      const { socket, session } = connect(hub, key, record.agentId);
      const runtime = hub.runtimeFor(record.agentId);
      const logs = runtime.followLogs("box", { tail: 0, timestamps: false })[Symbol.asyncIterator]();
      const first = logs.next();
      const id = String(framesOf(socket, "request").at(-1)?.id);
      session.receive(JSON.stringify({ type: "response", id, ok: true, result: {} }));
      session.receive(JSON.stringify({ type: "item", id, value: "first" }));
      expect(await first).toEqual({ done: false, value: "first" });
      // A single producer burst while the iterator is suspended: exercise both item and byte budgets.
      for (let i = 0; i < 2048; i++) session.receive(JSON.stringify({ type: "item", id, value: payload }));
      await expect(logs.next()).rejects.toMatchObject({
        kind: "unavailable",
        message: expect.stringContaining("buffer limit"),
      });
      expect(framesOf(socket, "cancel")).toEqual([{ type: "cancel", id }]);
      expect(hub.status(record.agentId)?.connected).toBe(true);
      const ping = runtime.ping();
      const pingId = framesOf(socket, "request").at(-1)?.id;
      session.receive(JSON.stringify({ type: "response", id: pingId, ok: true, result: {} }));
      await ping;
    });
  }

  test("a consumer that keeps up reads a long stream in order, including queued items before an end error", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const source = hub.runtimeFor(record.agentId).followLogs("box", { tail: 0, timestamps: false });
    const logs = source[Symbol.asyncIterator]();
    let reading = logs.next();
    const id = String(framesOf(socket, "request").at(-1)?.id);
    session.receive(JSON.stringify({ type: "response", id, ok: true, result: {} }));
    for (let i = 0; i < 2048; i++) {
      session.receive(JSON.stringify({ type: "item", id, value: String(i) }));
      expect(await reading).toEqual({ done: false, value: String(i) });
      if (i < 2047) reading = logs.next();
    }
    for (const value of ["last-a", "last-b"]) session.receive(JSON.stringify({ type: "item", id, value }));
    session.receive(
      JSON.stringify({ type: "end", id, error: { kind: "engine", message: "source failed", detail: "source failed" } }),
    );
    expect(await logs.next()).toEqual({ done: false, value: "last-a" });
    expect(await logs.next()).toEqual({ done: false, value: "last-b" });
    await expect(logs.next()).rejects.toMatchObject({ kind: "engine", message: "source failed" });
  });

  test("aborting a suspended log reader discards queued items and detaches the agent stream", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const abort = new AbortController();
    const source = hub
      .runtimeFor(record.agentId)
      .followLogs("box", { tail: 0, timestamps: false, signal: abort.signal });
    const logs = source[Symbol.asyncIterator]();
    const first = logs.next();
    const id = String(framesOf(socket, "request").at(-1)?.id);
    session.receive(JSON.stringify({ type: "response", id, ok: true, result: {} }));
    session.receive(JSON.stringify({ type: "item", id, value: "first" }));
    await first;
    session.receive(JSON.stringify({ type: "item", id, value: "stale" }));
    abort.abort();
    expect(await logs.next()).toMatchObject({ done: true });
    expect(framesOf(socket, "cancel")).toEqual([{ type: "cancel", id }]);
  });

  test("a stalled event reader is bounded and a replacement reader can open on the same connection", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const runtime = hub.runtimeFor(record.agentId);
    const events = runtime.events({})[Symbol.asyncIterator]();
    const first = events.next();
    const id = String(framesOf(socket, "request").at(-1)?.id);
    const event = {
      type: "container",
      action: "start",
      id: "box",
      attributes: {},
      time: "2026-10-29T00:00:00Z",
      timeNano: 1,
    };
    session.receive(JSON.stringify({ type: "response", id, ok: true, result: {} }));
    session.receive(JSON.stringify({ type: "item", id, value: event }));
    expect((await first).value).toEqual(event);
    for (let i = 0; i < 2048; i++) session.receive(JSON.stringify({ type: "item", id, value: event }));
    await expect(events.next()).rejects.toMatchObject({ kind: "unavailable" });
    const replacement = runtime.events({ since: 1 })[Symbol.asyncIterator]();
    const next = replacement.next();
    const newId = String(framesOf(socket, "request").at(-1)?.id);
    expect(newId).not.toBe(id);
    session.receive(JSON.stringify({ type: "response", id: newId, ok: true, result: {} }));
    session.receive(JSON.stringify({ type: "item", id: newId, value: event }));
    expect((await next).value).toEqual(event);
    await replacement.return?.();
  });

  test("a stream opens, delivers its output, items and exit to the sink, and then ends", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const items: unknown[] = [];
    const output: string[] = [];
    const ends: Array<{ error: unknown; exit: ExecExit | undefined }> = [];
    const handle = hub.open(
      record.agentId,
      "startExec",
      { containerId: "bx_1", spec: {} },
      {
        item: (value) => items.push(value),
        data: (channel, bytes) => output.push(`${channel}:${Buffer.from(bytes).toString()}`),
        end: (error, exit) => ends.push({ error, exit }),
      },
      { timeoutMs: 1000 },
    );
    expect(framesOf(socket, "request")[0]).toMatchObject({ id: handle.id, op: "startExec" });
    session.receive(JSON.stringify({ type: "response", id: handle.id, ok: true, result: { execId: "exec-1" } }));
    await expect(handle.opened).resolves.toEqual({ execId: "exec-1" });
    session.receive(
      JSON.stringify({ type: "data", id: handle.id, channel: "stdout", data: Buffer.from("hi\n").toString("base64") }),
    );
    session.receive(JSON.stringify({ type: "item", id: handle.id, value: { line: 1 } }));
    session.receive(JSON.stringify({ type: "end", id: handle.id, exit: { running: false, exitCode: 0, pid: 7 } }));
    expect(output).toEqual(["stdout:hi\n"]);
    expect(items).toEqual([{ line: 1 }]);
    expect(ends).toEqual([{ error: undefined, exit: { running: false, exitCode: 0, pid: 7 } }]);
  });

  test("input reaches the agent only once the stream has opened, and cancel tells the agent", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connect(hub, key, record.agentId);
    const sink = { item() {}, data() {}, end() {} };
    const handle = hub.open(record.agentId, "startExec", {}, sink, { timeoutMs: 1000 });
    handle.input(new Uint8Array([104, 105]));
    expect(framesOf(socket, "input")).toHaveLength(0);
    session.receive(JSON.stringify({ type: "response", id: handle.id, ok: true, result: {} }));
    handle.input(new Uint8Array([104, 105]));
    handle.inputEnd();
    expect(framesOf(socket, "input")).toEqual([
      { type: "input", id: handle.id, data: Buffer.from("hi").toString("base64") },
    ]);
    expect(framesOf(socket, "input_end")).toHaveLength(1);
    handle.cancel();
    expect(framesOf(socket, "cancel")).toEqual([{ type: "cancel", id: handle.id }]);
  });

  test("cancelling a stream before it opens settles its open as aborted, so nothing waits on it forever", async () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket } = connect(hub, key, record.agentId);
    const sink = { item() {}, data() {}, end() {} };
    const handle = hub.open(record.agentId, "events", {}, sink, { timeoutMs: 60_000 });
    handle.cancel();
    await expect(handle.opened).rejects.toMatchObject({ name: "AbortError" });
    expect(framesOf(socket, "cancel")).toEqual([{ type: "cancel", id: handle.id }]);
  });

  test("a stream opened while the agent is not connected fails at once and never reaches the sink", async () => {
    const { hub, enroll } = setup();
    const record = enroll();
    let reached = false;
    const handle = hub.open(
      record.agentId,
      "events",
      {},
      {
        item: () => {
          reached = true;
        },
        data: () => {
          reached = true;
        },
        end: () => {
          reached = true;
        },
      },
      { timeoutMs: 1000 },
    );
    await expect(handle.opened).rejects.toMatchObject({ kind: "unavailable" });
    expect(reached).toBe(false);
  });
});

describe("revocation and removal", () => {
  test("revoking drops the live connection at once with 4403, and the agent cannot reconnect", () => {
    const { hub, enroll, key, store } = setup();
    const record = enroll();
    const events: AgentEvent[] = [];
    hub.subscribe((event) => events.push(event));
    const { socket } = connect(hub, key, record.agentId);
    hub.revoke(record.agentId);
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.revoked, reason: "revoked" }]);
    expect(framesOf(socket, "refused")).toEqual([{ type: "refused", code: "revoked", message: expect.any(String) }]);
    expect(store.get(record.agentId)?.revokedAt).toBeString();
    expect(events.at(-1)).toEqual({ type: "revoked", agentId: record.agentId });
    const retry = connect(hub, key, record.agentId);
    expect(retry.socket.closed).toEqual([{ code: AGENT_CLOSE.revoked, reason: "revoked" }]);
  });

  test("when the revocation cannot be written, the revoke fails and the agent stays connected", () => {
    const { hub, enroll, key, store } = setup();
    const record = enroll();
    const { socket } = connect(hub, key, record.agentId);
    spyOn(store, "update").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => hub.revoke(record.agentId)).toThrow("disk full");
    expect(socket.closed).toEqual([]);
    expect(hub.status(record.agentId)).toMatchObject({ connected: true, revoked: false });
  });

  test("forgetting an agent removes its record and drops its connection", () => {
    const { hub, enroll, key, store } = setup();
    const record = enroll();
    const { socket } = connect(hub, key, record.agentId);
    hub.forget(record.agentId);
    expect(store.get(record.agentId)).toBeUndefined();
    expect(hub.status(record.agentId)).toBeNull();
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.revoked, reason: "removed" }]);
  });
});
