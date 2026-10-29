import type { KeyObject } from "node:crypto";

import { log } from "../lib/logger";
import { AgentExecutor, type AgentSink } from "./executor";
import {
  AGENT_CLOSE,
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
import type { AgentScope } from "./scope";
import type { ServedRuntime } from "./scoped-runtime";

/**
 * A refusal the control plane answers before it upgrades, so the agent's own WebSocket sees it as a failed handshake
 * rather than as a close frame. The WebSocket API exposes no status, only the error's text: Bun's client says
 * `Expected 101 status code: 429`, browsers and undici say `Unexpected server response: 429`. Both are read here.
 */
export function handshakeStatus(message: string): number | null {
  const found = /(?:unexpected server response|expected \d{3} status code|http)\s*[: ]\s*(\d{3})/i.exec(message);
  return found?.[1] ? Number(found[1]) : null;
}

const OPEN = 1;
const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/**
 * How long dialing may take before the socket opens: DNS, TCP, TLS and the upgrade. It is separate from the hello
 * timeout, which starts only once the socket is open, so a slow link or a tunnel does not spend the hello's 5 seconds.
 */
export const AGENT_CONNECT_TIMEOUT_MS = 30_000;

export type AgentConnectionState = "idle" | "connecting" | "connected" | "waiting" | "dormant" | "stopped";

export interface AgentClientOptions {
  /** The control plane's origin, such as https://minibox.example.com. */
  readonly server: string;
  readonly agentId: string;
  readonly privateKey: KeyObject;
  /** What the agent serves. In production this is the engine behind a `scopedRuntime`. */
  readonly runtime: ServedRuntime;
  /** Told what the control plane welcomes it with: an agent that has not adopted yet adopts once the welcome has come. */
  readonly scope?: AgentScope;
  readonly version: string;
  readonly heartbeatMs?: number;
  /** How long dialing may take before the socket opens. Defaults to `AGENT_CONNECT_TIMEOUT_MS`. */
  readonly connectTimeoutMs?: number;
  /** How long an open socket may wait for its welcome. Defaults to `AGENT_HELLO_TIMEOUT_MS`. */
  readonly helloTimeoutMs?: number;
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
 * protocol, ends the loop for good: the process stays up and idle, so a restart policy does not spin on a refusal. A
 * control plane that is saturated (429 before the upgrade, or `4411` on the socket) is not a reason to stop: the agent
 * is real, and the place it needs is taken by someone else's socket only until that one times out.
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
      // Dialing has its own budget; the hello's starts only once the socket is open.
      let helloTimer = setTimeout(() => ws.close(), this.options.connectTimeoutMs ?? AGENT_CONNECT_TIMEOUT_MS);
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

      ws.addEventListener("open", () => {
        if (settled || connected) return;
        clearTimeout(helloTimer);
        helloTimer = setTimeout(() => ws.close(), this.options.helloTimeoutMs ?? AGENT_HELLO_TIMEOUT_MS);
      });
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
            this.options.scope?.begin(frame.labelPrefix);
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
      ws.addEventListener("close", (event) => {
        // The code says what happened, so a log a person reads does not have to guess between a network drop and a
        // control plane that refused the socket. A session already ended was reported by whoever ended it: a refusal
        // before the upgrade is the error listener's, which Bun follows with a 1006 close that is not a second event.
        if (!settled) {
          if (event.code === AGENT_CLOSE.tooManyPending) {
            log.warn("agent.saturated", { code: event.code, reason: event.reason, connected });
          } else if (event.code === 1000 || event.code === 1001) {
            // A normal close, such as the control plane restarting: not a fault, but a person reading why the agent
            // reconnected should see it.
            log.info("agent.closed", { code: event.code, reason: event.reason, connected });
          } else {
            log.warn("agent.disconnected", { code: event.code, reason: event.reason, connected });
          }
        }
        finish({ dormant: false, connected });
      });
      ws.addEventListener("error", (event) => {
        const message = String((event as { message?: unknown }).message ?? "");
        if (handshakeStatus(message) === 429) {
          log.warn("agent.saturated", { status: 429, connected });
          finish({ dormant: false, connected });
          return;
        }
        log.warn("agent.socket_error", { message, connected });
        ws.close();
      });
    });
  }
}
