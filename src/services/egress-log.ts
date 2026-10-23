import { type ProxyEvent, parseProxyLine } from "../egress/proxy";
import type { AuditNote } from "../events/types";
import { log } from "../lib/logger";
import type { Runtime } from "../runtime";

/** The proxy container to read and the box it serves. The box is named by its container id, as its other events are. */
export interface EgressWatch {
  readonly proxyId: string;
  readonly containerId: string;
  readonly name: string;
}

export type EgressRecorder = (hostId: string, note: AuditNote) => void;

/**
 * Reads each egress proxy's log and records one event per connection: what was allowed, what was refused and what failed,
 * with the host, the port and the byte counts. The proxy never writes paths or bodies, so none reach an event.
 */
export class EgressLog {
  private readonly followers = new Map<string, AbortController>();

  constructor(private readonly record: EgressRecorder) {}

  /** Starts reading a proxy's log. A proxy already read is not read twice. */
  follow(runtime: Runtime, hostId: string, watch: EgressWatch): void {
    const key = followKey(hostId, watch.proxyId);
    const current = this.followers.get(key);
    if (current && !current.signal.aborted) return;
    const controller = new AbortController();
    this.followers.set(key, controller);
    void this.read(runtime, hostId, key, controller, watch);
  }

  stop(hostId: string, proxyId: string): void {
    const key = followKey(hostId, proxyId);
    this.followers.get(key)?.abort();
    this.followers.delete(key);
  }

  stopAll(): void {
    for (const controller of this.followers.values()) controller.abort();
    this.followers.clear();
  }

  private async read(
    runtime: Runtime,
    hostId: string,
    key: string,
    controller: AbortController,
    watch: EgressWatch,
  ): Promise<void> {
    try {
      const lines = runtime.followLogs(watch.proxyId, { tail: 0, timestamps: false, signal: controller.signal });
      for await (const line of lines) {
        const event = parseProxyLine(line);
        if (event) this.record(hostId, noteOf(event, watch));
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        log.warn("egress.log_failed", { host: hostId, proxy: watch.proxyId, error: String(e) });
      }
    } finally {
      if (this.followers.get(key) === controller) this.followers.delete(key);
    }
  }
}

const followKey = (hostId: string, proxyId: string) => `${hostId}/${proxyId}`;

function noteOf(event: ProxyEvent, watch: EgressWatch): AuditNote {
  const target = { kind: "box", id: watch.containerId, name: watch.name };
  const destination = `${event.host}:${event.port}`;
  switch (event.kind) {
    case "allowed":
      return {
        op: "egress.allowed",
        kind: "write",
        status: "ok",
        summary: `Egress to ${destination} allowed`,
        target,
        detail: {
          host: event.host,
          port: event.port,
          scheme: event.scheme,
          up: event.up,
          down: event.down,
          ms: event.ms,
        },
      };
    case "denied":
      return {
        op: "egress.denied",
        kind: "write",
        status: "denied",
        summary: `Egress to ${destination} denied`,
        target,
        detail: { host: event.host, port: event.port, reason: event.reason },
      };
    case "failed":
      return {
        op: "egress.failed",
        kind: "write",
        status: "error",
        summary: `Egress to ${destination} failed`,
        target,
        detail: { host: event.host, port: event.port, reason: event.reason },
      };
  }
}
