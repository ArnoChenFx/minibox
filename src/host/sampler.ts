import { untilAborted } from "../lib/abort";
import { log } from "../lib/logger";
import { type ContainerInfo, type ContainerStats, isRuntimeError, type RuntimeEvent } from "../runtime";
import { liveBox, projectBox } from "../services/box-view";
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
/** Longest a stats call may take. A longer interval waits this long for a sample at most. */
const STATS_TIMEOUT_MS = 5000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const IDLE_INTERVAL_MS = 30_000;
/** How often the containers are listed again, so a change the event stream never reported is caught up. */
const RELIST_MS = 60_000;
/** Longest a re-list waits for the engine's listing. A listing that is still pending past this is given up. */
const RELIST_TIMEOUT_MS = 30_000;

export interface SamplerOptions {
  /** Time between two sample rounds while a live subscriber watches. Host metrics use the same interval. */
  intervalMs: number;
  /** Time between two sample rounds while none does. Never shorter than `intervalMs`. */
  idleIntervalMs?: number;
  /** Time between two full listings of the containers. A stalled event stream hides a change for at most this long. */
  relistMs?: number;
  /** Longest a re-list waits for its listing. See `RELIST_TIMEOUT_MS`. */
  relistTimeoutMs?: number;
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

/** A running box and the container a sample of it is taken from. */
interface Target {
  boxId: string;
  containerId: string;
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
  /** The sample rounds, in order. A round's stats calls run here, outside the queue, so a slow engine stalls no write. */
  private rounds: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Live subscribers that asked for samples at the live interval. See `watch`. */
  private watchers = 0;
  /** Set when a subscriber has just arrived, so the next round runs without waiting for the cadence. */
  private expedited = false;
  /** When the last round ended, in epoch milliseconds. The next round is due one cadence later. */
  private roundEndedAt = 0;
  /** Ends the sample loop's current wait early, so it reads the cadence and the expedite flag again. */
  private wakeLoop: (() => void) | null = null;
  /** Counts the changes the cache takes in, so a listing taken before one of them is not applied over it. */
  private changes = 0;
  /** True while a re-list's listing is in flight, so that one listing at a time runs. */
  private relisting = false;

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
    this.roundEndedAt = Date.now();
    void this.run(this.abort.signal);
    void this.sampleLoop(this.abort.signal);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.abort?.abort();
    this.abort = null;
    this.wakeLoop?.();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.expedited = false;
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

  /** Resolves once every queued engine read, cache update and sample round has finished. */
  async settle(): Promise<void> {
    let queue: Promise<void>;
    let rounds: Promise<void>;
    do {
      queue = this.queue;
      rounds = this.rounds;
      await Promise.all([queue, rounds]);
    } while (queue !== this.queue || rounds !== this.rounds);
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

  /** Samples every running box now, outside the cadence. */
  sampleNow(): Promise<void> {
    return this.sampleRound();
  }

  /**
   * Asks for samples at the live interval until the returned function is called, and the first watcher gets a round at
   * once. While nobody watches, the boxes are sampled only at the idle interval, so an unwatched host costs one stats
   * call per running box per idle interval.
   */
  watch(): () => void {
    this.watchers += 1;
    if (this.watchers === 1) this.expedite();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers -= 1;
      this.wakeLoop?.();
    };
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
    let relist: ReturnType<typeof setInterval> | undefined;
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
      relist = setInterval(() => void this.relist(), this.options.relistMs ?? RELIST_MS);
      relist.unref();
      await streamed;
    } finally {
      clearInterval(relist);
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
    this.changes += 1;
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
    await this.adopt(infos);
    this.failures = 0;
    this.setState("live", null);
    this.reconcile();
    void this.sampleRound();
  }

  /**
   * Lists the containers again while the link is up, and publishes what the listing changed. The listing runs outside
   * the queue, and a listing that does not answer in time is given up, so an engine that hangs holds up no write. It is
   * applied in the queue only if the cache took no change while it was listed: a change made meanwhile may be newer than
   * the listing, and the next re-list catches up. The link is left as it is: the event stream still decides whether it
   * is up, and this only catches up what that stream never reported.
   */
  private async relist(): Promise<void> {
    const epoch = this.abort?.signal;
    if (!epoch || this.relisting || !this.ready()) return;
    const host = this.currentHost();
    const seen = this.changes;
    const timeoutMs = this.options.relistTimeoutMs ?? RELIST_TIMEOUT_MS;
    const deadline = AbortSignal.any([epoch, AbortSignal.timeout(timeoutMs)]);
    this.relisting = true;
    try {
      const infos = await untilAborted(host.runtime.listContainers({ labels: { [host.keys.box]: "true" } }), deadline);
      await this.enqueue(async () => {
        if (!this.ready() || this.changes !== seen) return;
        await this.adopt(infos);
        this.reconcile();
      });
    } catch (e) {
      if (epoch.aborted) return;
      log.warn("sampler.relist_failed", {
        host: host.host.id,
        error: deadline.aborted ? `no answer within ${timeoutMs} ms` : errorText(e),
      });
    } finally {
      this.relisting = false;
    }
  }

  /** Makes the cache hold exactly the listed containers, and gives a spec to each one that has none. */
  private async adopt(infos: ContainerInfo[]): Promise<void> {
    this.changes += 1;
    this.containers.clear();
    for (const info of infos) this.containers.set(info.id, info);
    await this.claimUnclaimed();
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

  /**
   * Runs one sample round after the rounds before it. The targets are picked in the queue, so they follow every change
   * queued before the round. The stats calls run outside the queue, and only the write of their results is queued again.
   */
  private sampleRound(): Promise<void> {
    const run = this.rounds
      .then(() => this.round())
      .catch((e: unknown) =>
        log.error("sampler.round_failed", { host: this.currentHost().host.id, error: errorText(e) }),
      )
      .finally(() => {
        this.roundEndedAt = Date.now();
      });
    this.rounds = run;
    return run;
  }

  private async round(): Promise<void> {
    const epoch = this.abort?.signal;
    const targets = await this.enqueue(async () => this.runningBoxes());
    if (!epoch || targets.length === 0) return;
    const timeoutMs = Math.min(this.options.intervalMs, STATS_TIMEOUT_MS);
    const samples = await mapLimit(targets, STATS_CONCURRENCY, (target) => this.sampleBox(target, epoch, timeoutMs));
    await this.enqueue(async () => this.record(epoch, targets, samples));
  }

  /** The running boxes whose container the cache holds. Empty while the cache is not current. */
  private runningBoxes(): Target[] {
    if (!this.ready()) return [];
    const targets: Target[] = [];
    for (const spec of this.specs.values()) {
      const info = this.containerOf(spec);
      if (info?.running) targets.push({ boxId: spec.id, containerId: info.id });
    }
    return targets;
  }

  /** One stats call. A call that has not answered by the timeout is a missed sample, not a failure of the round. */
  private async sampleBox(target: Target, epoch: AbortSignal, timeoutMs: number): Promise<ContainerStats | null> {
    const host = this.currentHost();
    const deadline = AbortSignal.any([epoch, AbortSignal.timeout(timeoutMs)]);
    try {
      return await untilAborted(host.runtime.containerStats(target.containerId, { signal: deadline }), deadline);
    } catch (e) {
      if (epoch.aborted || isRuntimeError(e, "not_found")) return null;
      log.warn("sampler.stats_failed", {
        host: host.host.id,
        container: target.containerId,
        error: deadline.aborted ? `no answer within ${timeoutMs} ms` : errorText(e),
      });
      return null;
    }
  }

  /** Writes the samples of a round into the rings and publishes them. A sample of a container that has since changed is dropped. */
  private record(epoch: AbortSignal, targets: Target[], samples: (ContainerStats | null)[]): void {
    if (this.abort?.signal !== epoch || !this.ready()) return;
    const host = this.currentHost();
    const t = Date.now();
    const boxes: BoxSample[] = [];
    const keep = Math.max(1, this.options.history);
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const stats = samples[index];
      if (!target || !stats || !this.runsContainer(target)) continue;
      const ring = this.rings.get(target.boxId) ?? [];
      ring.push({ t, ...stats });
      if (ring.length > keep) ring.splice(0, ring.length - keep);
      this.rings.set(target.boxId, ring);
      boxes.push({ boxId: target.boxId, ...stats });
    }
    if (boxes.length > 0) this.sink.publish("sample", { hostId: host.host.id, t, boxes });
  }

  /** True while the box still runs the container that a sample was taken from. */
  private runsContainer(target: Target): boolean {
    const spec = this.specs.get(target.boxId);
    const info = spec ? this.containerOf(spec) : undefined;
    return info?.id === target.containerId && info.running;
  }

  /** Runs a round whenever one is due, until the sampler stops. */
  private async sampleLoop(signal: AbortSignal): Promise<void> {
    while (await this.roundDue(signal)) {
      this.expedited = false;
      await this.sampleRound();
    }
  }

  /** Resolves true when a round is due, and false once the sampler stops. */
  private async roundDue(signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted) {
      const wait = this.roundEndedAt + this.cadence() - Date.now();
      if (this.expedited || wait <= 0) return true;
      await this.pause(wait);
    }
    return false;
  }

  /** Resolves after `ms`, or sooner when the loop is woken. Only one wait is pending at a time. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wakeLoop?.(), ms);
      timer.unref?.();
      this.wakeLoop = () => {
        clearTimeout(timer);
        this.wakeLoop = null;
        resolve();
      };
    });
  }

  private cadence(): number {
    if (this.watchers > 0) return this.options.intervalMs;
    return Math.max(this.options.intervalMs, this.options.idleIntervalMs ?? IDLE_INTERVAL_MS);
  }

  /** Makes the next round run without waiting for the cadence. Does nothing while the sampler is stopped. */
  private expedite(): void {
    if (!this.abort) return;
    this.expedited = true;
    this.wakeLoop?.();
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
      const box = liveBox(projectBox(host, spec, info));
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
