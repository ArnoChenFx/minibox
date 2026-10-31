import type { HostCtx, HostRegistry } from "../host/registry";
import { OWNER } from "../operations/types";
import type { RuntimeEvent } from "../runtime";
import type { RecordNote } from "./terminals";

/** The engine actions the activity tab shows. Other container actions, such as create or destroy, are not recorded. */
const RECORDED: Readonly<Record<string, { readonly op: string; readonly summary: string }>> = {
  start: { op: "container.start", summary: "Container started" },
  stop: { op: "container.stop", summary: "Container stopped" },
  oom: { op: "container.oom", summary: "Container ran out of memory" },
};

/**
 * Turns the engine's events for MiniBox boxes into `container.*` activity. The events are the host sampler's, so each
 * host keeps one engine subscription for the cache and for this watch alike. What MiniBox did not ask for is shown too:
 * a restart policy starting a box again, or the kernel killing it for memory. The sampler delivers an event once, even
 * when the engine replays it after a reconnect, so each change is recorded once.
 */
export class ContainerWatch {
  private readonly unsubscribes = new Map<string, () => void>();

  constructor(
    private readonly hosts: HostRegistry,
    private readonly record: RecordNote,
  ) {}

  start(): void {
    for (const host of this.hosts.list()) this.watch(host);
  }

  stop(): void {
    for (const hostId of this.unsubscribes.keys()) this.unwatch(hostId);
  }

  /** Starts recording a host's container events. A host already watched is not subscribed twice. */
  watch(host: HostCtx): void {
    if (this.unsubscribes.has(host.host.id)) return;
    this.unsubscribes.set(
      host.host.id,
      host.sampler.subscribeEvents((event) => this.observe(host, event)),
    );
  }

  unwatch(hostId: string): void {
    this.unsubscribes.get(hostId)?.();
    this.unsubscribes.delete(hostId);
  }

  private observe(host: HostCtx, event: RuntimeEvent): void {
    const recorded = RECORDED[event.action];
    if (!recorded) return;
    // The spec carries the name the box has now. The engine's event carries the labels of the create, and a rename does
    // not change them, so reading the label would name a renamed box by its old name.
    const spec = host.specs.findByContainer(event.id, "", host.host.id);
    const name = spec?.name ?? (event.attributes[host.keys.name] || event.attributes.name || event.id);
    this.record(host.host.id, "system", OWNER, {
      op: recorded.op,
      kind: "write",
      status: "ok",
      summary: `${recorded.summary}: ${name}`,
      target: { kind: "box", id: event.id, name },
    });
  }
}
