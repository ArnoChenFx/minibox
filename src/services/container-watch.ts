import type { HostCtx, HostRegistry } from "../host/registry";
import { log } from "../lib/logger";
import type { RuntimeEvent } from "../runtime";
import type { RecordNote } from "./terminals";

/** The engine actions the activity tab shows. Other container actions, such as create or destroy, are not recorded. */
const RECORDED: Readonly<Record<string, { readonly op: string; readonly summary: string }>> = {
  start: { op: "container.start", summary: "Container started" },
  stop: { op: "container.stop", summary: "Container stopped" },
  oom: { op: "container.oom", summary: "Container ran out of memory" },
};

export interface ContainerWatchOptions {
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
}

/**
 * Turns the engine's events for MiniBox boxes into `container.*` activity. The stream is the engine's, so it also shows
 * what MiniBox did not ask for: a restart policy starting a box again, or the kernel killing it for memory. Events that
 * happen while the stream is down are not replayed.
 */
export class ContainerWatch {
  private controller: AbortController | null = null;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly hosts: HostRegistry,
    private readonly record: RecordNote,
    options: ContainerWatchOptions = {},
  ) {
    this.retryMinMs = options.retryMinMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    for (const host of this.hosts.list()) void this.follow(host, controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async follow(host: HostCtx, signal: AbortSignal): Promise<void> {
    let delay = this.retryMinMs;
    while (!signal.aborted) {
      try {
        const events = host.runtime.events({ labels: { [host.keys.box]: "true" }, types: ["container"] }, signal);
        for await (const event of events) {
          delay = this.retryMinMs;
          this.observe(host, event);
        }
      } catch (e) {
        if (signal.aborted) return;
        log.warn("container.watch_failed", { host: host.host.id, error: String(e), retryMs: delay });
      }
      if (signal.aborted) return;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, this.retryMaxMs);
    }
  }

  private observe(host: HostCtx, event: RuntimeEvent): void {
    const recorded = RECORDED[event.action];
    if (!recorded) return;
    const name = event.attributes[host.keys.name] || event.attributes.name || event.id;
    this.record(host.host.id, "system", {
      op: recorded.op,
      kind: "write",
      status: "ok",
      summary: `${recorded.summary}: ${name}`,
      target: { kind: "box", id: event.id, name },
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
