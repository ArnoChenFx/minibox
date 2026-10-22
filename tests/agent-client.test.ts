import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { AgentClient, backoffMs, connectUrlOf } from "../src/agent/client";
import { AGENT_PROTOCOL, verifyHello } from "../src/agent/protocol";
import { silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const AGENT_ID = "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c";
const NONCE = "n".repeat(32);

/** A WebSocket stand-in: the test feeds it frames and watches what the client sends. */
class FakeSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
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
    this.dispatch("message", { data: JSON.stringify(frame) });
  }

  /** The connection dropping without a close from the client, as a network failure does. */
  drop(): void {
    this.readyState = 3;
    this.dispatch("close", {});
  }

  framesOf(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

function setup(overrides: { heartbeatMs?: number } = {}) {
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
    openSocket: () => {
      const socket = new FakeSocket();
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
