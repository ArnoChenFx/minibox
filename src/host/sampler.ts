import { log } from "../lib/logger";
import { type ContainerInfo, type ContainerStats, isRuntimeError, type RuntimeEvent } from "../runtime";
import { projectBox } from "../services/box-view";
import type { Box } from "../services/boxes";
import { ClaimError, ensureSpec } from "../specs/claim";
import type { SpecChange } from "../specs/store";
import type { BoxSpec } from "../specs/types";
import { type BoxSample, type LinkState, type LiveSink, NO_LIVE, type StatSample } from "./live";
import type { HostCtx } from "./registry";

/** Container actions that can change how a box looks. Exec, attach and the like leave the box as it was. */
const STATE_VERBS = new Set([
  "create",
  "start",
  "restart",
  "die",
  "stop",
  "kill",
  "pause",
  "unpause",
  "oom",
  "rename",
  "update",
  "health_status",
]);
const STATS_CONCURRENCY = 8;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export interface SamplerOptions {
  /** Time between two sample rounds. Host metrics use the same interval. */
  intervalMs: number;
  /** Samples kept per box. The oldest are dropped first. */
  history: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export interface BoxTotals {
  total: number;
  running: number;
  allocatedCpus: number;
  allocatedMemory: number;
  unlimited: number;
}

/** The allocation of the boxes in `infos`. A box without a CPU or memory limit counts as unlimited. */
export function summarizeBoxes(infos: Iterable<ContainerInfo>): BoxTotals {
  const totals: BoxTotals = { total: 0, running: 0, allocatedCpus: 0, allocatedMemory: 0, unlimited: 0 };
  for (const info of infos) {
    totals.total += 1;
    if (info.cpus === null || info.memoryBytes === null) totals.unlimited += 1;
    if (!info.running) continue;
    totals.running += 1;
    totals.allocatedCpus += info.cpus ?? 0;
    totals.allocatedMemory += info.memoryBytes ?? 0;
  }
  return { ...totals, allocatedCpus: Math.round(totals.allocatedCpus * 100) / 100 };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * One sampler per host. It keeps a cache of the host's boxes current from the engine's container events, samples the
 * resource use of the running boxes into a short ring per box, and publishes what changed on the sink.
 *
 * Every engine read that updates the cache and every cache update runs in one queue, in the order the work arrived.
 * An inspect issued before a later event therefore cannot overwrite what that event reported. The subscription opens
 * before the listing, so a change made while the listing runs is applied after it.
 */
export class HostSampler {
  private started = false;
  private state: LinkState = "down";
  private failures = 0;
  private readonly containers = new Map<string, ContainerInfo>();
  private readonly specs = new Map<string, BoxSpec>();
  private readonly shown = new Map<string, { containerId: string; json: string }>();
  private readonly rings = new Map<string, StatSample[]>();
  private readonly dirty = new Map<string, "refresh" | "remove">();
  private drainQueued = false;
  private queue: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly currentHost: () => HostCtx,
    private readonly options: SamplerOptions,
    private readonly sink: LiveSink = NO_LIVE,
  ) {}

  isStarted(): boolean {
    return this.started;
  }

  /** True while the cache is current: the sampler is running, subscribed to events, and has listed the engine. */
  ready(): boolean {
    return this.started && this.state === "live";
  }

  start(): void {
    if (this.started) return;
    const host = this.currentHost();
    this.started = true;
    for (const spec of host.specs.list()) {
      if (spec.hostId === host.host.id) this.specs.set(spec.id, spec);
    }
    this.unsubscribe = host.specs.subscribe((change) => this.onSpec(change));
    this.abort = new AbortController();
    void this.run(this.abort.signal);
    this.scheduleRound(this.options.intervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.abort?.abort();
    this.abort = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    this.containers.clear();
    this.specs.clear();
    this.shown.clear();
    this.rings.clear();
    this.failures = 0;
    this.setState("down", "stopped");
  }

  /**
   * Re-reads the given containers once the changes queued before this call are applied, so a caller that just changed a
   * box sees the change in the cache. Does nothing when not started.
   */
  observe(...containerIds: string[]): Promise<void> {
    if (!this.started) return Promise.resolve();
    for (const containerId of containerIds) this.markDirty(containerId, "refresh");
    return this.enqueue(() => this.drain());
  }

  /** Resolves once every queued engine read and cache update has finished. */
  settle(): Promise<void> {
    return this.queue;
  }

  /** The boxes the cache holds, projected as the list endpoint shows them, sorted by name. */
  boxes(options: { withStats: boolean }): Box[] {
    const host = this.currentHost();
    const boxes: Box[] = [];
    for (const spec of this.specs.values()) {
      const info = this.containerOf(spec);
      if (!info) continue;
      const box = projectBox(host, spec, info);
      if (options.withStats) box.stats = box.running ? this.statsOf(spec.id) : null;
      boxes.push(box);
    }
    return boxes.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** The cached box a reference names. A miss is left to a read of the engine. */
  find(ref: string): Box | null {
    const host = this.currentHost();
    for (const spec of this.specs.values()) {
      if (spec.id !== ref && spec.name !== ref && spec.containerName !== ref) continue;
      const info = this.containerOf(spec);
      if (info) return projectBox(host, spec, info);
    }
    const info = this.containers.get(ref);
    const spec = info ? this.specOf(info) : undefined;
    return info && spec ? projectBox(host, spec, info) : null;
  }

  statsOf(boxId: string): ContainerStats | null {
    const last = this.rings.get(boxId)?.at(-1);
    if (!last) return null;
    return {
      cpuPercent: last.cpuPercent,
      memUsage: last.memUsage,
      memLimit: last.memLimit,
      memPercent: last.memPercent,
    };
  }

  historyOf(boxId: string): StatSample[] {
    return [...(this.rings.get(boxId) ?? [])];
  }

  /** Totals over the cached boxes, or `null` while the cache is not current. */
  summary(): BoxTotals | null {
    if (!this.ready()) return null;
    const infos: ContainerInfo[] = [];
    for (const spec of this.specs.values()) {
      const info = this.containerOf(spec);
      if (info) infos.push(info);
    }
    return summarizeBoxes(infos);
  }

  /** Samples every running box now, as the timer does once per interval. */
  sampleNow(): Promise<void> {
    return this.enqueue(() => this.round());
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let reason = "the event stream ended";
      try {
        await this.session(signal);
      } catch (e) {
        reason = errorText(e);
      }
      if (signal.aborted) return;
      this.setState("down", reason);
      const delay = Math.min(
        this.options.backoffMaxMs ?? BACKOFF_MAX_MS,
        (this.options.backoffMinMs ?? BACKOFF_MIN_MS) * 2 ** this.failures,
      );
      this.failures += 1;
      log.warn("sampler.link_down", { host: this.currentHost().host.id, error: reason, retryInMs: delay });
      await sleep(delay, signal);
    }
  }

  /** One subscription and the listing that follows it. Returns or throws when the link is lost. */
  private async session(parent: AbortSignal): Promise<void> {
    const host = this.currentHost();
    const ctl = new AbortController();
    const end = () => ctl.abort();
    parent.addEventListener("abort", end, { once: true });
    try {
      // `since` makes the engine replay what it recorded from a second before, which covers the moment the subscription
      // is still being established, so no change can fall between the subscription and the listing.
      const events = host.runtime.events(
        { labels: { [host.keys.box]: "true" }, types: ["container"], since: Math.floor(Date.now() / 1000) - 1 },
        ctl.signal,
      );
      const streamed = this.consume(events);
      streamed.catch(end);
      await this.enqueue(() => this.resync()).catch((e: unknown) => {
        end();
        throw e;
      });
      await streamed;
    } finally {
      ctl.abort();
      parent.removeEventListener("abort", end);
    }
  }

  private async consume(events: AsyncIterable<RuntimeEvent>): Promise<void> {
    for await (const event of events) this.onEvent(event);
  }

  private onEvent(event: RuntimeEvent): void {
    const verb = event.action.split(":")[0]?.trim() ?? "";
    if (verb === "destroy") this.markDirty(event.id, "remove");
    else if (STATE_VERBS.has(verb)) this.markDirty(event.id, "refresh");
    else return;
    this.schedule();
  }

  /** A removal outranks a refresh that was queued for the same container. */
  private markDirty(containerId: string, op: "refresh" | "remove"): void {
    if (this.dirty.get(containerId) !== "remove") this.dirty.set(containerId, op);
  }

  private schedule(): void {
    if (this.drainQueued) return;
    this.drainQueued = true;
    void this.enqueue(() => this.drain());
  }

  private async drain(): Promise<void> {
    this.drainQueued = false;
    if (!this.started) return;
    try {
      while (this.dirty.size > 0) {
        const batch = [...this.dirty];
        this.dirty.clear();
        for (const [containerId, op] of batch) {
          if (op === "remove") this.containers.delete(containerId);
          else await this.refresh(containerId);
        }
      }
      await this.claimUnclaimed();
      this.reconcile();
    } catch (e) {
      log.error("sampler.drain_failed", { host: this.currentHost().host.id, error: errorText(e) });
    }
  }

  private async refresh(containerId: string): Promise<void> {
    const host = this.currentHost();
    try {
      const info = await host.runtime.inspectContainer(containerId);
      if (this.started) this.containers.set(containerId, info);
    } catch (e) {
      if (isRuntimeError(e, "not_found")) this.containers.delete(containerId);
      else log.warn("sampler.inspect_failed", { host: host.host.id, container: containerId, error: errorText(e) });
    }
  }

  private async resync(): Promise<void> {
    const host = this.currentHost();
    const infos = await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } });
    if (!this.started) return;
    this.containers.clear();
    for (const info of infos) this.containers.set(info.id, info);
    await this.claimUnclaimed();
    this.failures = 0;
    this.setState("live", null);
    this.reconcile();
    void this.enqueue(() => this.round()).catch((e: unknown) =>
      log.error("sampler.round_failed", { host: host.host.id, error: errorText(e) }),
    );
  }

  /**
   * Gives every container that has no spec one, as the list endpoint always did. A container whose id label names a box
   * that now lives in another container is the leftover of a rebuild, and is left alone.
   */
  private async claimUnclaimed(): Promise<void> {
    const host = this.currentHost();
    for (const info of this.containers.values()) {
      if (this.specOf(info) || this.isStale(info)) continue;
      try {
        await ensureSpec(host, info);
      } catch (e) {
        if (e instanceof ClaimError) {
          log.warn("box.claim_skipped", { host: host.host.id, container: info.name, error: e.message });
        } else {
          log.error("box.claim_failed", { host: host.host.id, container: info.name, error: errorText(e) });
        }
      }
    }
  }

  private async round(): Promise<void> {
    if (!this.ready()) return;
    const host = this.currentHost();
    const targets: { boxId: string; containerId: string }[] = [];
    for (const spec of this.specs.values()) {
      const info = this.containerOf(spec);
      if (info?.running) targets.push({ boxId: spec.id, containerId: info.id });
    }
    const samples = await mapLimit(targets, STATS_CONCURRENCY, async (target) => {
      try {
        return { boxId: target.boxId, stats: await host.runtime.containerStats(target.containerId) };
      } catch (e) {
        if (!isRuntimeError(e, "not_found")) {
          log.warn("sampler.stats_failed", { host: host.host.id, container: target.containerId, error: errorText(e) });
        }
        return null;
      }
    });
    const t = Date.now();
    const boxes: BoxSample[] = [];
    const keep = Math.max(1, this.options.history);
    for (const sample of samples) {
      if (!sample) continue;
      const ring = this.rings.get(sample.boxId) ?? [];
      ring.push({ t, ...sample.stats });
      if (ring.length > keep) ring.splice(0, ring.length - keep);
      this.rings.set(sample.boxId, ring);
      boxes.push({ boxId: sample.boxId, ...sample.stats });
    }
    if (boxes.length > 0) this.sink.publish("sample", { hostId: host.host.id, t, boxes });
  }

  private scheduleRound(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue(() => this.round())
        .catch((e: unknown) =>
          log.error("sampler.round_failed", { host: this.currentHost().host.id, error: errorText(e) }),
        )
        .finally(() => {
          if (this.started) this.scheduleRound(this.options.intervalMs);
        });
    }, delay);
    this.timer.unref?.();
  }

  private onSpec(change: SpecChange): void {
    if (!this.started) return;
    if (change.kind === "write") {
      if (change.spec.hostId !== this.currentHost().host.id) return;
      this.specs.set(change.spec.id, change.spec);
    } else {
      if (!this.specs.delete(change.id)) return;
      this.rings.delete(change.id);
    }
    this.reconcile();
  }

  /** Publishes each box whose view changed, and a removal for each box that no longer has a container. */
  private reconcile(): void {
    if (!this.started) return;
    const host = this.currentHost();
    const hostId = host.host.id;
    const present = new Set<string>();
    for (const spec of this.specs.values()) {
      const info = this.containerOf(spec);
      if (!info) continue;
      present.add(spec.id);
      const box = projectBox(host, spec, info);
      const json = JSON.stringify(box);
      const previous = this.shown.get(spec.id);
      if (previous?.containerId === info.id && previous.json === json) continue;
      this.shown.set(spec.id, { containerId: info.id, json });
      this.sink.publish("box", { hostId, op: "upsert", boxId: spec.id, containerId: info.id, box });
    }
    for (const [boxId, previous] of this.shown) {
      if (present.has(boxId)) continue;
      this.shown.delete(boxId);
      this.sink.publish("box", { hostId, op: "remove", boxId, containerId: previous.containerId });
    }
  }

  private setState(state: LinkState, error: string | null): void {
    if (this.state === state) return;
    this.state = state;
    this.sink.publish("link", { hostId: this.currentHost().host.id, state, error, at: new Date().toISOString() });
  }

  /** The spec a container belongs to, by container id or, as the claim does, by name. */
  private specOf(info: ContainerInfo): BoxSpec | undefined {
    for (const spec of this.specs.values()) {
      if (spec.containerId === info.id || spec.containerName === info.name) return spec;
    }
    return undefined;
  }

  /** The container a spec runs in. A spec that still names a replaced container is matched by name. */
  private containerOf(spec: BoxSpec): ContainerInfo | undefined {
    return (
      this.containers.get(spec.containerId) ??
      [...this.containers.values()].find((info) => info.name === spec.containerName)
    );
  }

  private isStale(info: ContainerInfo): boolean {
    const holder = this.specs.get(info.labels[this.currentHost().keys.id] ?? "");
    return holder !== undefined && holder.containerId !== info.id && holder.containerName !== info.name;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
