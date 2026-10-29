import { afterEach, describe, expect, jest, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_CLOSE,
  AGENT_CONNECT_PATH,
  AGENT_HELLO_TIMEOUT_MS,
  AGENT_PROTOCOL,
  signHello,
} from "../src/agent/protocol";
import {
  AGENT_HELLO_MAX_BYTES,
  AGENT_PENDING_MAX,
  AGENT_PENDING_PER_ADDRESS_MAX,
  AgentHub,
  type AgentSocket,
} from "../src/host/agent/hub";
import { PairingBook } from "../src/host/agent/pairing";
import { AgentStore } from "../src/host/agent/store";
import { setLogSink } from "../src/lib/logger";
import { pendingLimitError, startServer } from "../src/server";
import { createTestApp, silenceLogs } from "./support/app";

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
const servers: Array<{ stop: (force?: boolean) => void }> = [];
let restoreLogs: (() => void) | undefined;
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreLogs?.();
  restoreLogs = undefined;
});

function setup(limits: { pendingMax?: number; pendingPerAddressMax?: number; now?: () => Date } = {}) {
  restoreLogs ??= silenceLogs();
  const dataDir = mkdtempSync(join(tmpdir(), "minibox-hub-cap-test-"));
  dirs.push(dataDir);
  const store = new AgentStore(dataDir);
  const hub = new AgentHub({
    store,
    pairing: new PairingBook(),
    serverVersion: "0.4.0-test",
    ...(limits.pendingMax === undefined ? {} : { pendingMax: limits.pendingMax }),
    ...(limits.pendingPerAddressMax === undefined ? {} : { pendingPerAddressMax: limits.pendingPerAddressMax }),
    ...(limits.now === undefined ? {} : { now: limits.now }),
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

const LOCAL = "203.0.113.7";
const OTHER = "198.51.100.9";

/** Opens a socket that says nothing yet, and keeps the hub's end so the test can answer or drop it later. */
function open(hub: AgentHub, address = LOCAL) {
  const socket = fakeSocket();
  const session = hub.attach(socket, address);
  return { socket, session };
}

/** Opens `count` sockets from one address that never say hello, in the order they were attached. */
function silent(hub: AgentHub, count: number, address = LOCAL) {
  return Array.from({ length: count }, () => open(hub, address));
}

/** Opens a socket and answers its challenge with a hello, so the agent is connected. */
function connectAgent(hub: AgentHub, key: KeyObject, agentId: string, address = LOCAL) {
  const { socket, session } = open(hub, address);
  session.receive(helloFrame(key, nonceOf(socket), agentId));
  return { socket, session };
}

const refusedCount = (sockets: FakeSocket[]) => sockets.filter((socket) => socket.closed.length > 0).length;

describe("the cap on sockets that have not authenticated", () => {
  test("every socket under the per-address limit is challenged, and none of them is closed", () => {
    const { hub } = setup();
    const sockets = silent(hub, AGENT_PENDING_PER_ADDRESS_MAX).map((held) => held.socket);
    expect(sockets.map((socket) => framesOf(socket, "challenge").length)).toEqual(
      Array.from({ length: AGENT_PENDING_PER_ADDRESS_MAX }, () => 1),
    );
    expect(refusedCount(sockets)).toBe(0);
  });

  test("a socket past its address's limit is closed 4411 before it is challenged, and it never becomes a session", () => {
    const { hub } = setup();
    silent(hub, AGENT_PENDING_PER_ADDRESS_MAX);
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

  test("an agent on another address still connects while one address is saturated", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    // One address fills its own places and stays there, saying nothing.
    const crowd = silent(hub, AGENT_PENDING_PER_ADDRESS_MAX);
    expect(crowd.map((held) => held.socket.closed.length)).toEqual(
      Array.from({ length: AGENT_PENDING_PER_ADDRESS_MAX }, () => 0),
    );
    expect(open(hub, LOCAL).socket.closed).toEqual([REFUSED]);
    // The real agent arrives from somewhere else, and is challenged and welcomed as usual.
    const agent = connectAgent(hub, key, record.agentId, OTHER);
    expect(agent.socket.closed).toEqual([]);
    expect(framesOf(agent.socket, "challenge")).toHaveLength(1);
    expect(framesOf(agent.socket, "welcome")).toHaveLength(1);
    expect(hub.status(record.agentId)?.connected).toBe(true);
  });

  test("the global cap is the backstop: a crowd spread over many addresses is refused once it is reached", () => {
    const { hub } = setup({ pendingMax: 3, pendingPerAddressMax: 2 });
    const crowd = [open(hub, "a"), open(hub, "a"), open(hub, "b"), open(hub, "c")];
    expect(crowd.map((held) => held.socket.closed.length)).toEqual([0, 0, 0, 1]);
    // The address limit still bites first on a fourth address, which the global count has room for.
    expect(hub.pendingRefusal("d")).toEqual({ scope: "total", pending: 3, max: 3 });
    expect(hub.pendingRefusal("a")).toEqual({ scope: "address", pending: 2, max: 2 });
  });

  test("a refused socket holds nothing, so the next one from that address is refused too", () => {
    const { hub } = setup({ pendingPerAddressMax: 1 });
    silent(hub, 1);
    expect(open(hub).socket.closed).toEqual([REFUSED]);
    expect(open(hub).socket.closed).toEqual([REFUSED]);
  });

  test("a socket that times out waiting for a hello gives its place back", () => {
    const { hub } = setup({ pendingPerAddressMax: 1 });
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
    const { hub } = setup({ pendingPerAddressMax: 1 });
    const first = open(hub);
    first.session.detach();
    const next = open(hub);
    expect(next.socket.closed).toEqual([]);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("a socket refused at hello gives its place back", () => {
    const { hub, enroll } = setup({ pendingPerAddressMax: 1 });
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
    const { hub, enroll, key } = setup({ pendingPerAddressMax: 1 });
    const record = enroll();
    hub.revoke(record.agentId);
    const socket = fakeSocket();
    hub.attach(socket, LOCAL).receive(helloFrame(key, nonceOf(socket), record.agentId));
    expect(socket.closed).toEqual([{ code: AGENT_CLOSE.revoked, reason: "revoked" }]);
    const next = open(hub);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("closing the hub gives every waiting place back, so a later socket is challenged again", () => {
    const { hub } = setup({ pendingPerAddressMax: 1 });
    silent(hub, 1);
    hub.close();
    const next = open(hub);
    expect(framesOf(next.socket, "challenge")).toHaveLength(1);
  });

  test("a hello that verifies gives its place back at once, so the next socket is not refused", () => {
    const { hub, enroll, key } = setup({ pendingPerAddressMax: 2 });
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

  test("an authenticated agent holds no place, so it reconnects with the waiting limit nearly full", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    connectAgent(hub, key, record.agentId);
    silent(hub, AGENT_PENDING_PER_ADDRESS_MAX - 1);

    const reconnect = connectAgent(hub, key, record.agentId);
    expect(reconnect.socket.closed).toEqual([]);
    expect(framesOf(reconnect.socket, "welcome")).toHaveLength(1);
    expect(hub.status(record.agentId)?.connected).toBe(true);
  });

  test("both limits are configurable for a test: set to 1, the first socket is challenged and the second is refused", () => {
    const { hub } = setup({ pendingMax: 1, pendingPerAddressMax: 1 });
    const first = open(hub);
    const second = open(hub);
    expect(framesOf(first.socket, "challenge")).toHaveLength(1);
    expect(first.socket.closed).toEqual([]);
    expect(second.socket.closed).toEqual([REFUSED]);
    expect(framesOf(second.socket, "challenge")).toEqual([]);
  });

  test("a crowd past the address limit leaves exactly that many waiting, however many arrive", () => {
    const { hub } = setup({ pendingMax: 1, pendingPerAddressMax: 1 });
    const sockets = silent(hub, AGENT_PENDING_MAX + 3).map((held) => held.socket);
    expect(sockets.filter((socket) => framesOf(socket, "challenge").length > 0)).toHaveLength(1);
    expect(refusedCount(sockets)).toBe(AGENT_PENDING_MAX + 2);
  });

  test("a socket that has not said hello cannot send a large frame, and is closed 1009 instead of parsing it", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const first = open(hub);
    first.session.receive("x".repeat(AGENT_HELLO_MAX_BYTES + 1));
    expect(first.socket.closed).toEqual([{ code: 1009, reason: "frame too large before the hello" }]);
    // The place is given back, so the agent that arrives next is served.
    const agent = connectAgent(hub, key, record.agentId);
    expect(framesOf(agent.socket, "welcome")).toHaveLength(1);
  });

  test("an authenticated agent may send frames far past the hello's size, which is how a log read arrives", () => {
    const { hub, enroll, key } = setup();
    const record = enroll();
    const { socket, session } = connectAgent(hub, key, record.agentId);
    const big = JSON.stringify({
      type: "item",
      id: "stream",
      value: "y".repeat(AGENT_HELLO_MAX_BYTES * 4),
    });
    session.receive(big);
    expect(socket.closed).toEqual([]);
    expect(hub.status(record.agentId)?.connected).toBe(true);
  });

  test("a flood of refusals is logged once a minute, and the next line carries the count it hid", () => {
    let clock = new Date("2026-10-29T00:00:00.000Z");
    const { hub } = setup({ pendingPerAddressMax: 1, now: () => clock });
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      silent(hub, 1);
      for (let i = 0; i < 5; i++) open(hub);
      const first = lines.filter((line) => line.includes("agent.pending_limit"));
      expect(first).toHaveLength(1);
      expect(JSON.parse(first[0] ?? "{}")).toMatchObject({
        address: LOCAL,
        scope: "address",
        pending: 1,
        max: 1,
      });

      // A minute later one line is written again, and it says how many it kept quiet in between.
      clock = new Date("2026-10-29T00:01:00.000Z");
      open(hub);
      const all = lines.filter((line) => line.includes("agent.pending_limit"));
      expect(all).toHaveLength(2);
      expect(JSON.parse(all[1] ?? "{}")).toMatchObject({ suppressed: 4 });
    } finally {
      restore();
    }
  });
});

/** A WebSocket handshake whose status line and body are read back, so the test sees the refusal, not an upgrade. */
function upgradeAttempt(
  port: number,
  headers: Record<string, string>,
  socket = netConnect(port, "127.0.0.1"),
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${AGENT_CONNECT_PATH} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      const end = raw.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = Number(raw.split(" ")[1]);
      const body = raw.slice(end + 4);
      resolve({ status, body });
    });
    socket.on("error", reject);
  });
}

describe("the connect route answers over the limit with 429, before the upgrade", () => {
  test("a socket past its address's limit gets 429 and a JSON error; another address is still upgraded", async () => {
    restoreLogs = silenceLogs();
    const { app } = createTestApp({ trustProxy: true });
    const server = startServer(app);
    servers.push(server);
    const port = server.port;
    if (!port) throw new Error("the test server has no port");

    // Fill one address's places with requests that are upgraded and then never say hello. The clients stay open, so the
    // sockets the server holds are the ones that count.
    const held: Socket[] = [];
    for (let i = 0; i < AGENT_PENDING_PER_ADDRESS_MAX; i++) {
      const socket = netConnect(port, "127.0.0.1");
      const attempt = upgradeAttempt(port, { "X-Forwarded-For": LOCAL }, socket);
      held.push(socket);
      expect((await attempt).status).toBe(101);
    }
    // The hub counts the sockets it was given, which the server attached as they opened.
    await waitFor(() => app.agents.pendingRefusal(LOCAL) !== null, "the address to fill up");

    const refused = await upgradeAttempt(port, { "X-Forwarded-For": LOCAL });
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: {
        code: "too_many_requests",
        key: "agent_pending_limit",
        retryable: true,
        details: { scope: "address", pending: AGENT_PENDING_PER_ADDRESS_MAX, max: AGENT_PENDING_PER_ADDRESS_MAX },
      },
    });

    // The agent on another address is upgraded and challenged, so one saturated address does not lock the others out.
    const other = netConnect(port, "127.0.0.1");
    const answer = await upgradeAttempt(port, { "X-Forwarded-For": OTHER }, other);
    expect(answer.status).toBe(101);
    await waitFor(() => app.agents.pendingRefusal(OTHER) === null, "the other address's socket to be attached");

    for (const socket of [...held, other]) socket.destroy();
    app.hostAdmin.close();
    app.sessions.stop();
    app.tokens.stop();
    app.events.close();
  });
});

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

describe("the 429 says which limit was reached", () => {
  test("one address over its limit is told about its address; the total over its limit is told about every address", () => {
    const address = pendingLimitError({ scope: "address", pending: 8, max: 8 });
    expect(address.status).toBe(429);
    expect(address.key).toBe("agent_pending_limit");
    expect(address.message).toContain("from one address");

    const total = pendingLimitError({ scope: "total", pending: 256, max: 256 });
    expect(total.status).toBe(429);
    expect(total.key).toBe("agent_pending_total_limit");
    expect(total.message).toContain("across all addresses");
    expect(total.message).toContain("256");
    expect(total.message).not.toContain("from one address");
    expect(total.details).toEqual({ scope: "total", pending: 256, max: 256 });
  });
});
