import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { AgentClient, backoffMs, connectUrlOf, handshakeStatus } from "../src/agent/client";
import { AGENT_CLOSE, AGENT_PROTOCOL, verifyHello } from "../src/agent/protocol";
import type { AgentScope } from "../src/agent/scope";
import { setLogSink } from "../src/lib/logger";
import { silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const AGENT_ID = "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c";
const NONCE = "n".repeat(32);

/** A WebSocket stand-in: the test feeds it frames and watches what the client sends. */
class FakeSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: unknown; code?: number; reason?: string; message?: string }) => void>
  >();

  /** Opens on its own once the client has listened, as a socket that dials at once does, unless told to wait. */
  constructor(autoOpen = true) {
    if (autoOpen) queueMicrotask(() => this.open());
  }

  /** The dial finishing: DNS, TCP, TLS and the upgrade are done. */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.dispatch("open", {});
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    queueMicrotask(() => this.dispatch("close", {}));
  }

  /** A frame from the control plane. */
  receive(frame: Record<string, unknown>): void {
    this.open();
    this.dispatch("message", { data: JSON.stringify(frame) });
  }

  /** The connection dropping without a close from the client, as a network failure does. */
  drop(): void {
    this.readyState = 3;
    this.dispatch("close", {});
  }

  /** The control plane closing the socket, with the code and reason it gave. */
  closeWith(code: number, reason: string): void {
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }

  /** The handshake failing before the upgrade, in Bun's own words. */
  failHandshake(status: number): void {
    this.readyState = 3;
    this.dispatch("error", {
      message: `WebSocket connection to 'ws://minibox.example.com/api/agent/connect' failed: Expected 101 status code: ${status}`,
    });
    // Bun follows a refused upgrade with an abnormal close, as a probe against a real server shows.
    this.dispatch("close", { code: 1006, reason: "" });
  }

  framesOf(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }

  private dispatch(type: string, event: { data?: unknown; code?: number; reason?: string; message?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

function setup(
  overrides: {
    heartbeatMs?: number;
    connectTimeoutMs?: number;
    helloTimeoutMs?: number;
    autoOpen?: boolean;
    scope?: AgentScope;
  } = {},
) {
  const pair = generateKeyPairSync("ed25519");
  const sockets: FakeSocket[] = [];
  const runtime = new FakeRuntime();
  const client = new AgentClient({
    server: "https://minibox.example.com",
    agentId: AGENT_ID,
    privateKey: pair.privateKey,
    runtime,
    version: "0.4.0",
    minBackoffMs: 5,
    maxBackoffMs: 10,
    heartbeatMs: overrides.heartbeatMs ?? 60_000,
    ...(overrides.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: overrides.connectTimeoutMs }),
    ...(overrides.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: overrides.helloTimeoutMs }),
    ...(overrides.scope === undefined ? {} : { scope: overrides.scope }),
    openSocket: () => {
      const socket = new FakeSocket(overrides.autoOpen ?? true);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return { client, sockets, runtime, publicKeyPem };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

describe("the agent's connection URL and retry delay", () => {
  test("the socket address follows the control plane's scheme", () => {
    expect(connectUrlOf("https://minibox.example.com")).toBe("wss://minibox.example.com/api/agent/connect");
    expect(connectUrlOf("http://10.0.0.5:3920/")).toBe("ws://10.0.0.5:3920/api/agent/connect");
  });

  test("the delay doubles from the minimum, stays under the cap, and carries a fifth of jitter", () => {
    expect(backoffMs(1, 1_000, 30_000)).toBeGreaterThanOrEqual(800);
    expect(backoffMs(1, 1_000, 30_000)).toBeLessThanOrEqual(1_200);
    expect(backoffMs(3, 1_000, 30_000)).toBeGreaterThanOrEqual(3_200);
    expect(backoffMs(3, 1_000, 30_000)).toBeLessThanOrEqual(4_800);
    expect(backoffMs(50, 1_000, 30_000)).toBeLessThanOrEqual(36_000);
  });
});

describe("the connection", () => {
  test("a challenge is answered with a hello that the control plane can verify", async () => {
    const { client, sockets, publicKeyPem } = setup();
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    const [hello] = sockets[0]?.framesOf("hello") ?? [];
    expect(hello).toMatchObject({ type: "hello", agentId: AGENT_ID, protocol: AGENT_PROTOCOL, version: "0.4.0" });
    expect(verifyHello(publicKeyPem, NONCE, AGENT_ID, AGENT_PROTOCOL, String(hello?.signature))).toBe(true);
    client.stop();
    await done;
  });

  test("a welcome marks the agent connected, and heartbeats follow at the interval", async () => {
    const { client, sockets } = setup({ heartbeatMs: 10 });
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    expect(client.connectionState).toBe("connected");
    await waitFor(() => (sockets[0]?.framesOf("heartbeat").length ?? 0) >= 3, "three heartbeats");
    client.stop();
    await done;
  });

  test("a welcome tells the agent's scope which label prefix the control plane names, and a welcome that names none says so", async () => {
    const begun: Array<string | undefined> = [];
    const scope = { begin: (prefix: string | undefined) => begun.push(prefix) } as unknown as AgentScope;
    const { client, sockets } = setup({ scope });
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    // Nothing is told before the control plane has accepted the agent.
    expect(begun).toEqual([]);
    sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL, labelPrefix: "minibox" });
    expect(begun).toEqual(["minibox"]);

    sockets[0]?.drop();
    await waitFor(() => sockets.length === 2, "the reconnect");
    sockets[1]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[1]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    expect(begun).toEqual(["minibox", undefined]);
    client.stop();
    await done;
  });

  test("a request from the control plane runs on the agent's runtime, and its answer goes back", async () => {
    const { client, sockets, runtime } = setup();
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    sockets[0]?.receive({ type: "request", id: "req-1", op: "ping", args: {} });
    await waitFor(() => sockets[0]?.framesOf("response").length === 1, "the response");
    expect(runtime.callsTo("ping")).toHaveLength(1);
    expect(sockets[0]?.framesOf("response")).toMatchObject([{ type: "response", id: "req-1", ok: true }]);
    client.stop();
    await done;
  });

  test("an operation outside the allowlist is answered as refused, and the runtime never sees it", async () => {
    const { client, sockets, runtime } = setup();
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    sockets[0]?.receive({ type: "request", id: "req-2", op: "diskUsage", args: {} });
    await waitFor(() => sockets[0]?.framesOf("response").length === 1, "the refusal");
    expect(sockets[0]?.framesOf("response")[0]).toMatchObject({
      id: "req-2",
      ok: false,
      error: { kind: "unsupported" },
    });
    expect(runtime.callsTo("diskUsage")).toHaveLength(0);
    client.stop();
    await done;
  });

  test("a revocation ends the loop: the agent stays up, is dormant, and does not dial again", async () => {
    const { client, sockets } = setup();
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[0]?.receive({ type: "refused", code: "revoked", message: "This agent was revoked." });
    await done;
    expect(client.connectionState).toBe("dormant");
    await Bun.sleep(30);
    expect(sockets).toHaveLength(1);
  });

  test("a dropped connection is retried after a backoff, and the agent connects again", async () => {
    const { client, sockets } = setup();
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    sockets[0]?.drop();
    await waitFor(() => sockets.length === 2, "a second connection");
    sockets[1]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[1]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    expect(client.connectionState).toBe("connected");
    client.stop();
    await done;
  });

  test("stop closes the socket normally and ends the loop", async () => {
    const { client, sockets } = setup();
    const done = client.run();
    sockets[0]?.receive({ type: "challenge", nonce: NONCE, protocol: AGENT_PROTOCOL, serverVersion: "0.4.0" });
    sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
    client.stop();
    await done;
    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: "agent stopped" }]);
    expect(client.connectionState).toBe("stopped");
  });

  test("stop during the wait before a retry means no new connection is opened", async () => {
    const { client, sockets } = setup();
    const done = client.run();
    sockets[0]?.drop();
    client.stop();
    await done;
    await Bun.sleep(30);
    expect(sockets).toHaveLength(1);
    expect(client.connectionState).toBe("stopped");
  });
});

/** The log lines one run writes, so a test can read what an operator would see. */
function logLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  return { lines, restore: setLogSink((_level, line) => lines.push(line)) };
}

describe("a saturated control plane", () => {
  test("a socket closed 4411 is logged with its code and retried, not treated as an ordinary drop", async () => {
    const { client, sockets } = setup();
    const logs = logLines();
    const done = client.run();
    try {
      sockets[0]?.closeWith(AGENT_CLOSE.tooManyPending, "too many sockets waiting for a hello");
      await waitFor(() => sockets.length === 2, "a second connection");
      const saturated = logs.lines.filter((line) => line.includes("agent.saturated"));
      expect(saturated).toHaveLength(1);
      expect(JSON.parse(saturated[0] ?? "{}")).toMatchObject({
        code: AGENT_CLOSE.tooManyPending,
        reason: "too many sockets waiting for a hello",
        connected: false,
      });
      // The drop is reported as saturation, so the ordinary disconnect line is not written for it as well.
      expect(logs.lines.filter((line) => line.includes("agent.disconnected"))).toHaveLength(0);
      expect(client.connectionState).not.toBe("dormant");
    } finally {
      client.stop();
      await done;
      logs.restore();
    }
  });

  test("a 429 before the upgrade is logged as saturation, and the agent dials again", async () => {
    const { client, sockets } = setup();
    const logs = logLines();
    const done = client.run();
    try {
      sockets[0]?.failHandshake(429);
      await waitFor(() => sockets.length === 2, "a second connection");
      const saturated = logs.lines.filter((line) => line.includes("agent.saturated"));
      expect(saturated).toHaveLength(1);
      expect(JSON.parse(saturated[0] ?? "{}")).toMatchObject({ status: 429, connected: false });
      expect(logs.lines.filter((line) => line.includes("agent.socket_error"))).toHaveLength(0);
      // The 1006 close Bun sends after the refusal belongs to the same event, so it is not logged as a second one.
      expect(logs.lines.filter((line) => line.includes("agent.disconnected"))).toHaveLength(0);
    } finally {
      client.stop();
      await done;
      logs.restore();
    }
  });

  test("another handshake refusal keeps the socket error line, and the code of an ordinary close is reported", async () => {
    const { client, sockets } = setup();
    const logs = logLines();
    const done = client.run();
    try {
      sockets[0]?.failHandshake(503);
      await waitFor(() => sockets.length === 2, "a second connection");
      expect(logs.lines.filter((line) => line.includes("agent.socket_error"))).toHaveLength(1);
      sockets[1]?.closeWith(1006, "connection lost");
      const disconnected = logs.lines.filter((line) => line.includes("agent.disconnected"));
      expect(JSON.parse(disconnected.at(-1) ?? "{}")).toMatchObject({ code: 1006, reason: "connection lost" });
    } finally {
      client.stop();
      await done;
      logs.restore();
    }
  });

  test("a normal close, such as the control plane restarting, is logged at info with its code, and the agent dials again", async () => {
    const { client, sockets } = setup();
    const lines: Array<{ level: string; line: string }> = [];
    const restore = setLogSink((level, line) => lines.push({ level, line }));
    const done = client.run();
    try {
      sockets[0]?.closeWith(1001, "server stopping");
      await waitFor(() => sockets.length === 2, "a second connection");
      const closed = lines.filter((entry) => entry.line.includes("agent.closed"));
      expect(closed).toHaveLength(1);
      expect(closed[0]?.level).toBe("info");
      expect(JSON.parse(closed[0]?.line ?? "{}")).toMatchObject({ code: 1001, reason: "server stopping" });
      expect(lines.filter((entry) => entry.line.includes("agent.disconnected"))).toHaveLength(0);
    } finally {
      client.stop();
      await done;
      restore();
    }
  });

  test("the handshake status is read from the error text, and unknown text is no status at all", () => {
    // Bun's client, as it actually reports a refused upgrade.
    expect(
      handshakeStatus("WebSocket connection to 'ws://host/api/agent/connect' failed: Expected 101 status code: 429"),
    ).toBe(429);
    // Browsers and undici.
    expect(handshakeStatus("Unexpected server response: 503")).toBe(503);
    expect(handshakeStatus("failed: HTTP 401")).toBe(401);
    expect(handshakeStatus("socket hang up")).toBeNull();
    expect(handshakeStatus("")).toBeNull();
  });
});

describe("the agent's timers", () => {
  test("the hello timeout starts when the socket opens, so a slow dial does not spend it", async () => {
    const { client, sockets } = setup({ autoOpen: false, helloTimeoutMs: 30, connectTimeoutMs: 10_000 });
    const logs = logLines();
    const done = client.run();
    try {
      await waitFor(() => sockets.length === 1, "the first dial");
      // Longer than the hello timeout, still dialing: nothing closes the socket.
      await Bun.sleep(90);
      expect(sockets[0]?.closes).toHaveLength(0);
      sockets[0]?.open();
      // Open and silent: now the hello timeout runs, and the agent closes the socket and dials again.
      await waitFor(() => (sockets[0]?.closes.length ?? 0) === 1, "the hello timeout to close the socket");
      await waitFor(() => sockets.length === 2, "a second dial");
      // The log says which timeout it was, which the close that follows does not.
      expect(logs.lines.filter((line) => line.includes("agent.hello_timeout"))).toHaveLength(1);
      expect(logs.lines.filter((line) => line.includes("agent.connect_timeout"))).toHaveLength(0);
    } finally {
      client.stop();
      await done;
      logs.restore();
    }
  });

  test("a dial that never opens is given up after the connect timeout, and the agent dials again", async () => {
    const { client, sockets } = setup({ autoOpen: false, connectTimeoutMs: 30, helloTimeoutMs: 10_000 });
    const logs = logLines();
    const done = client.run();
    try {
      await waitFor(() => (sockets[0]?.closes.length ?? 0) === 1, "the connect timeout to close the socket");
      await waitFor(() => sockets.length === 2, "a second dial");
      expect(logs.lines.filter((line) => line.includes("agent.connect_timeout"))).toHaveLength(1);
      expect(logs.lines.filter((line) => line.includes("agent.hello_timeout"))).toHaveLength(0);
    } finally {
      client.stop();
      await done;
      logs.restore();
    }
  });

  test("the welcome stops the hello timeout, so a connected agent is not closed by it", async () => {
    const { client, sockets } = setup({ helloTimeoutMs: 30 });
    const done = client.run();
    try {
      await waitFor(() => sockets.length === 1, "the first dial");
      sockets[0]?.receive({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL });
      await waitFor(() => client.connectionState === "connected", "the welcome");
      await Bun.sleep(90);
      expect(sockets[0]?.closes).toHaveLength(0);
      expect(sockets).toHaveLength(1);
    } finally {
      client.stop();
      await done;
    }
  });
});
