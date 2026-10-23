import type { HostCtx, HostRegistry } from "../host/registry";
import type { RuntimeEvent } from "../runtime";
import { hasStartup, scheduleStartup } from "./startup";

const STARTED_ACTIONS: ReadonlySet<string> = new Set(["start", "restart"]);

/**
 * Relaunches a box's startup command when the engine starts its container without a request from MiniBox: a restart
 * policy, a `docker start`, or the daemon coming back after a reboot. The start MiniBox makes itself is seen here too. Every
 * such start goes through the box's startup check, which launches the command only when its init session is missing, so
 * one container never gets two launches. Each host keeps its own subscription, as the container watch does.
 */
export class StartupWatch {
  private readonly unsubscribes = new Map<string, () => void>();

  constructor(private readonly hosts: HostRegistry) {}

  start(): void {
    for (const host of this.hosts.list()) this.watch(host);
  }

  stop(): void {
    for (const hostId of this.unsubscribes.keys()) this.unwatch(hostId);
  }

  /** Starts relaunching a host's startup commands. A host already watched is not subscribed twice. */
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
    if (!STARTED_ACTIONS.has(event.action)) return;
    const spec = host.specs.findByContainer(event.id, "", host.host.id);
    if (!spec || spec.lifecycle.desired !== "running" || !hasStartup(spec)) return;
    scheduleStartup(host, spec.id);
  }
}
