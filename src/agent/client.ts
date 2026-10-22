import type { KeyObject } from "node:crypto";

import { log } from "../lib/logger";
import type { Runtime } from "../runtime";
import { AgentExecutor, type AgentSink } from "./executor";
import {
  AGENT_CONNECT_PATH,
  AGENT_HEARTBEAT_MS,
  AGENT_HELLO_TIMEOUT_MS,
  AGENT_PROTOCOL,
  type AgentFrame,
  decodeBytes,
  encodeBytes,
  parseFrame,
  ServerFrameSchema,
  signHello,
} from "./protocol";

const OPEN = 1;
const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export type AgentConnectionState = "idle" | "connecting" | "connected" | "waiting" | "dormant" | "stopped";

export interface AgentClientOptions {
  /** The control plane's origin, such as https://minibox.example.com. */
  readonly server: string;
  readonly agentId: string;
  readonly privateKey: KeyObject;
  readonly runtime: Runtime;
  readonly version: string;
  readonly heartbeatMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Opens the socket. Tests pass a stand-in; the agent uses Bun's WebSocket. */
  readonly openSocket?: (url: string) => WebSocket;
}

type SessionEnd =
  | { readonly dormant: false; readonly connected: boolean }
  | { readonly dormant: true; readonly reason: string };

/** The URL of the agent socket for a control plane origin. */
export function connectUrlOf(server: string): string {
  const url = new URL(AGENT_CONNECT_PATH, server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Exponential backoff from `minMs`, capped at `maxMs`, with a fifth of jitter either way so a fleet does not reconnect in step. */
export function backoffMs(attempt: number, minMs: number, maxMs: number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Keeps one agent connected to its control plane. It connects, proves its identity with its key, serves what the control
 * plane asks, sends a heartbeat, and reconnects with backoff. A control plane that revokes the agent, or refuses its
 * protocol, ends the loop for good: the process stays up and idle, so a restart policy does not spin on a refusal.
 */
export class AgentClient {
  private state: AgentConnectionState = "idle";
  private stopped = false;
  private socket: WebSocket | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: AgentClientOptions) {}

  get connectionState(): AgentConnectionState {
    return this.state;
  }

  /** Runs until `stop` or until the control plane refuses this agent for good. */
  async run(): Promise<void> {
    const min = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    let attempt = 0;
    while (!this.stopped) {
      this.state = "connecting";
      const end = await this.session();
      if (this.stopped) break;
      if (end.dormant) {
        this.state = "dormant";
        log.error("agent.dormant", { reason: end.reason });
        return;
      }
      attempt = end.connected ? 1 : attempt + 1;
      this.state = "waiting";
      await this.sleep(backoffMs(attempt, min, max));
    }
    this.state = "stopped";
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close(1000, "agent stopped");
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = null;
    });
  }

  private session(): Promise<SessionEnd> {
    return new Promise((resolve) => {
      const { agentId, privateKey, runtime, version } = this.options;
      const url = connectUrlOf(this.options.server);
      const ws = this.options.openSocket?.(url) ?? new WebSocket(url);
      this.socket = ws;
      let connected = false;
      let executor: AgentExecutor | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const helloTimer = setTimeout(() => ws.close(), AGENT_HELLO_TIMEOUT_MS);
      let settled = false;

      const send = (frame: AgentFrame) => {
        if (ws.readyState === OPEN) ws.send(JSON.stringify(frame));
      };
      const sink: AgentSink = {
        respond: (id, outcome) =>
          send(
            outcome.ok
              ? { type: "response", id, ok: true, result: outcome.result }
              : { type: "response", id, ok: false, error: outcome.error },
          ),
        item: (id, value) => send({ type: "item", id, value }),
        data: (id, channel, bytes) => send({ type: "data", id, channel, data: encodeBytes(bytes) }),
        end: (id, error, exit) => send({ type: "end", id, ...(error ? { error } : {}), ...(exit ? { exit } : {}) }),
      };

      const finish = (end: SessionEnd) => {
        if (settled) return;
        settled = true;
        clearTimeout(helloTimer);
        if (heartbeat) clearInterval(heartbeat);
        executor?.close();
        this.socket = null;
        resolve(end);
      };

      ws.addEventListener("message", (event) => {
        const frame = parseFrame(ServerFrameSchema, String(event.data));
        if (!frame) return;
        switch (frame.type) {
          case "challenge":
            if (frame.protocol !== AGENT_PROTOCOL) {
              log.error("agent.protocol_mismatch", { control: frame.protocol, agent: AGENT_PROTOCOL });
            }
            send({
              type: "hello",
              agentId,
              protocol: AGENT_PROTOCOL,
              version,
              signature: signHello(privateKey, frame.nonce, agentId, AGENT_PROTOCOL),
            });
            return;
          case "welcome":
            connected = true;
            clearTimeout(helloTimer);
            this.state = "connected";
            executor = new AgentExecutor(runtime, sink);
            heartbeat = setInterval(
              () => send({ type: "heartbeat", at: new Date().toISOString() }),
              this.options.heartbeatMs ?? AGENT_HEARTBEAT_MS,
            );
            log.info("agent.connected", { hostId: frame.hostId, version });
            return;
          case "refused":
            log.error("agent.refused", { code: frame.code, message: frame.message });
            finish({ dormant: true, reason: frame.message });
            ws.close();
            return;
          case "request":
            void executor?.request(frame.id, frame.op, frame.args);
            return;
          case "input":
            executor?.input(frame.id, decodeBytes(frame.data));
            return;
          case "input_end":
            executor?.inputEnd(frame.id);
            return;
          case "cancel":
            executor?.cancel(frame.id);
            return;
        }
      });
      ws.addEventListener("close", () => {
        log.warn("agent.disconnected", { connected });
        finish({ dormant: false, connected });
      });
      ws.addEventListener("error", () => {
        ws.close();
      });
    });
  }
}
