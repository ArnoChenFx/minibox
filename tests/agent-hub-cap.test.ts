import { afterEach, describe, expect, jest, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CLOSE, AGENT_HELLO_TIMEOUT_MS, AGENT_PROTOCOL, signHello } from "../src/agent/protocol";
import { AGENT_PENDING_MAX, AgentHub, type AgentSocket } from "../src/host/agent/hub";
import { PairingBook } from "../src/host/agent/pairing";
import { AgentStore } from "../src/host/agent/store";
import { silenceLogs } from "./support/app";

const AGENT_VERSION = "0.4.0";
const REFUSED = { code: AGENT_CLOSE.tooManyPending, reason: "too many sockets waiting for a hello" };

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
let restoreLogs: (() => void) | undefined;
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreLogs?.();
  restoreLogs = undefined;
});

function setup(pendingMax?: number) {
  restoreLogs ??= silenceLogs();
  const dataDir = mkdtempSync(join(tmpdir(), "minibox-hub-cap-test-"));
  dirs.push(dataDir);
  const store = new AgentStore(dataDir);
  const hub = new AgentHub({
    store,
    pairing: new PairingBook(),
    serverVersion: "0.4.0-test",
    ...(pendingMax === undefined ? {} : { pendingMax }),
  });
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

function helloFrame(key: KeyObject, nonce: string, agentId: string): string {
  return JSON.stringify({
    type: "hello",
    agentId,
    protocol: AGENT_PROTOCOL,
    version: AGENT_VERSION,
    signature: signHello(key, nonce, agentId, AGENT_PROTOCOL),
  });
}

/** Opens a socket that says nothing yet, and keeps the hub's end so the test can answer or drop it later. */
function open(hub: AgentHub) {
  const socket = fakeSocket();
  const session = hub.attach(socket);
  return { socket, session };
}

/** Opens `count` sockets that never say hello, in the order they were attached. */
function silent(hub: AgentHub, count: number) {
  return Array.from({ length: count }, () => open(hub));
}

/** Opens a socket and answers its challenge with a hello, so the agent is connected. */
function connect(hub: AgentHub, key: KeyObject, agentId: string) {
  const { socket, session } = open(hub);
  session.receive(helloFrame(key, nonceOf(socket), agentId));
  return { socket, session };
}

const refusedCount = (sockets: FakeSocket[]) => sockets.filter((socket) => socket.closed.length > 0).length;

describe("the cap on sockets that have not authenticated", () => {
  test("every socket under the cap is challenged, and none of them is closed", () => {
    const { hub } = setup();
    const sockets = silent(hub, AGENT_PENDING_MAX).map((held) => held.socket);
    expect(sockets.map((socket) => framesOf(socket, "challenge").length)).toEqual(
      Array.from({ length: AGENT_PENDING_MAX }, () => 1),
    );
    expect(refusedCount(sockets)).toBe(0);
  });

  test("a socket past the cap is closed 4411 before it is challenged, and it never becomes a session", () => {
    const { hub } = setup();
    silent(hub, AGENT_PENDING_MAX);
    const { socket, session } = open(hub);
    expect(socket.closed).toEqual([REFUSED]);
    expect(framesOf(socket, "challenge")).toEqual([]);
    // The refused socket has no session behind it, so a frame arriving on it does nothing at all.
    session.receive(
      JSON.stringify({
        type: "hello",
        agentId: "a".repeat(32),
        protocol: AGENT_PROTOCOL,
        version: "1",
        signature: "x",
      }),
    );
    expect(socket.sent).toEqual([]);
    expect(hub.status("a".repeat(32))).toBeNull();
  });

  test("a refused socket holds nothing, so the next one is refused too", () => {
    const { hub } = setup(1);
    silent(hub, 1);
    expect(open(hub).socket.closed).toEqual([REFUSED]);
    expect(open(hub).socket.closed).toEqual([REFUSED]);
  });

  test("a socket that times out waiting for a hello gives its place back", () => {
    const { hub } = setup(1);
    jest.useFakeTimers();
    try {
      const first = open(hub);
      expect(first.socket.closed).toEqual([]);
      expect(open(hub).socket.closed).toEqual([REFUSED]);

      jest.advanceTimersByTime(AGENT_HELLO_TIMEOUT_MS);
      expect(first.socket.closed).toEqual([{ code: AGENT_CLOSE.helloTimeout, reason: "no hello" }]);

      const next = open(hub);
      expect(next.socket.closed).toEqual([]);
      expect(framesOf(next.socket, "challenge")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a socket that disconnects on its own gives its place back", () => {
    const { hub } = setup(1);
    const first = open(hub);
    first.session.detach();
    const next = open(hub);
    expect(next.socket.closed).toEqual([]);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("a socket refused at hello gives its place back", () => {
    const { hub, enroll } = setup(1);
    const record = enroll();
    const stranger = generateKeyPairSync("ed25519").privateKey;
    const wrongKey = open(hub);
    wrongKey.session.receive(helloFrame(stranger, nonceOf(wrongKey.socket), record.agentId));
    expect(wrongKey.socket.closed).toEqual([{ code: AGENT_CLOSE.authFailed, reason: "auth failed" }]);
    const next = open(hub);
    expect(next.socket.closed).toEqual([]);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("a revoked agent's socket gives its place back as well", () => {
    const { hub, enroll, key } = setup(1);
    const record = enroll();
    hub.revoke(record.agentId);
    const socket = fakeSocket();
    hub.attach(socket).receive(helloFrame(key, nonceOf(socket), record.agentId));
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.revoked, reason: "revoked" }]);
    const next = open(hub);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("closing the hub gives every waiting place back, so a later socket is challenged again", () => {
    const { hub } = setup(1);
    silent(hub, 1);
    hub.close();
    const next = open(hub);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("a hello that verifies gives its place back at once, so the next socket is not refused", () => {
    const { hub, enroll, key } = setup(2);
    const record = enroll();
    const waiting = silent(hub, 2);
    expect(open(hub).socket.closed).toEqual([REFUSED]);

    const first = waiting[0];
    if (!first) throw new Error("the setup opened no socket");
    first.session.receive(helloFrame(key, nonceOf(first.socket), record.agentId));
    expect(framesOf(first.socket, "welcome")).toHaveLength(1);
    expect(hub.status(record.agentId)?.connected).toBe(true);

    const next = open(hub);
    expect(next.socket.closed).toEqual([]);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("an authenticated agent holds no place, so it reconnects with the waiting cap nearly full", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    connect(hub, key, record.agentId);
    silent(hub, AGENT_PENDING_MAX - 1);

    const reconnect = connect(hub, key, record.agentId);
    expect(reconnect.socket.closed).toEqual([]);
    expect(framesOf(reconnect.socket, "welcome")).toHaveLength(1);
    expect(hub.status(record.agentId)?.connected).toBe(true);
  });

  test("the cap is configurable: set to 1, the first socket is challenged and the second is refused", () => {
    const { hub } = setup(1);
    const first = open(hub);
    const second = open(hub);
    expect(framesOf(first.socket, "challenge")).toHaveLength(1);
    expect(first.socket.closed).toEqual([]);
    expect(second.socket.closed).toEqual([REFUSED]);
    expect(framesOf(second.socket, "challenge")).toEqual([]);
  });

  test("a crowd past the cap leaves exactly the cap waiting, however many arrive", () => {
    const { hub } = setup(1);
    const sockets = silent(hub, AGENT_PENDING_MAX + 3).map((held) => held.socket);
    expect(sockets.filter((socket) => framesOf(socket, "challenge").length > 0)).toHaveLength(1);
    expect(refusedCount(sockets)).toBe(AGENT_PENDING_MAX + 2);
  });
});
