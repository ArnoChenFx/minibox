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
/**
 * How long one `need()` keeps the samples going while no live subscriber watches. A reader of usage renews it, so
 * a host that nobody reads costs no stats call once the lease runs out.
 */
export const DEMAND_LEASE_MS = 5 * 60_000;
/** A sample older than this is not reported. The idle cadence sits well inside it, so a leased sampler keeps it current. */
const STALE_AFTER_MS = 60_000;
/** How often the containers are listed again, so a change the event stream never reported is caught up. */
const RELIST_MS = 60_000;
/** Longest a re-list waits for the engine's listing. A listing that is still pending past this is given up. */
const RELIST_TIMEOUT_MS = 30_000;
/** Longest a container inspect may take. A longer one keeps the cached entry, and the next round reads it again. */
const INSPECT_TIMEOUT_MS = 5000;
/** Longest the first listing after a subscription may take. A longer one takes the link down, and backoff retries. */
const LIST_TIMEOUT_MS = 30_000;
/** Longest `observe()` waits for the queued writes. Past it, the caller goes on, and the writes still run in order. */
const OBSERVE_WAIT_MS = 5000;

export interface SamplerOptions {
  /** Time between two sample rounds while a live subscriber watches. Host metrics use the same interval. */
  intervalMs: number;
  /** Time between two sample rounds while none does. Never shorter than `intervalMs`. */
  idleIntervalMs?: number;
  /** Age past which a sample is no longer reported. See `STALE_AFTER_MS`. */
  staleAfterMs?: number;
  /** Time between two full listings of the containers. A stalled event stream hides a change for at most this long. */
  relistMs?: number;
  /** Longest a re-list waits for its listing. See `RELIST_TIMEOUT_MS`. */
  relistTimeoutMs?: number;
  /** Longest a container inspect may take. See `INSPECT_TIMEOUT_MS`. */
  inspectTimeoutMs?: number;
  /** Longest the first listing after a subscription may take. See `LIST_TIMEOUT_MS`. */
  listTimeoutMs?: number;
  /** Longest `observe()` waits for the queued writes. See `OBSERVE_WAIT_MS`. */
  observeWaitMs?: number;
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

/** Resolves once `promise` settles, or after `ms`, whichever comes first. The promise itself is left to finish. */
function waitUpTo(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    promise.then(done, done);
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
 * before the listing, so a change made while the listing runs is applied after it. A read that does not answer in time
 * is given up, so one hung engine call holds the queue for a bounded time only (see `refresh` and `resync`).
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
  /** Containers whose inspect got no answer in time. Their entries are kept, and the next round reads them again. */
  private readonly stale = new Set<string>();
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
  /** Sampling is wanted until this time while no live subscriber watches. See `need`. */
  private needUntil = 0;
  /** The round queued or running now, so the callers that ask meanwhile share it. */
  private pendingRound: Promise<void> | null = null;
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
    this.needUntil = 0;
    this.roundEndedAt = 0;
    this.dirty.clear();
    this.stale.clear();
    this.containers.clear();
    this.specs.clear();
    this.shown.clear();
    this.rings.clear();
    this.failures = 0;
    this.setState("down", "stopped");
  }

  /**
   * Re-reads the given containers once the changes queued before this call are applied, so a caller that just changed a
   * box sees the change in the cache. Resolves after `observeWaitMs` at the latest, even when the queue is still held
   * up by a read that has not answered: the writes still run in order once it does. Does nothing when not started.
   */
  observe(...containerIds: string[]): Promise<void> {
    if (!this.started) return Promise.resolve();
    for (const containerId of containerIds) this.markDirty(containerId, "refresh");
    return waitUpTo(
      this.enqueue(() => this.drain()),
      this.options.observeWaitMs ?? OBSERVE_WAIT_MS,
    );
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

  /** The newest sample of a box, or `null` when there is none, or the newest is older than the stale age. */
  statsOf(boxId: string): ContainerStats | null {
    const last = this.rings.get(boxId)?.at(-1);
    if (!last || Date.now() - last.t >= this.staleMs()) return null;
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
   * Keeps samples going for `ms` from now while no live subscriber watches. Every reader of usage calls this, so a host
   * is sampled while its usage is read, and stops once nobody has read it for the lease.
   */
  need(ms: number = DEMAND_LEASE_MS): void {
    this.needUntil = Math.max(this.needUntil, Date.now() + ms);
    this.wakeLoop?.();
  }

  /** True while a live subscriber watches. The host metrics are published, and the engine read for them, only then. */
  watched(): boolean {
    return this.watchers > 0;
  }

  /**
   * Resolves once the samples are current: at once when the last round is recent, else when a round has run, or after
   * `ms`, whichever comes first. Callers that ask while a round is queued or running share that round.
   */
  sampleSoon(ms: number = STATS_TIMEOUT_MS): Promise<void> {
    this.need();
    if (Date.now() - this.roundEndedAt < this.staleMs()) return Promise.resolve();
    return waitUpTo(this.sampleRound(), ms);
  }

  /**
   * Asks for samples at the live interval until the returned function is called, and the first watcher gets a round at
   * once. While nobody watches, samples go on only at the idle interval, and only within a lease taken by `need`: once
   * the lease runs out, an unwatched host makes no stats call at all.
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
      await this.enqueue(() => this.resync(parent)).catch((e: unknown) => {
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
      while (this.started && this.dirty.size > 0) {
        const batch = [...this.dirty];
        this.dirty.clear();
        for (const [containerId, op] of batch) {
          if (op === "remove") {
            this.containers.delete(containerId);
            this.stale.delete(containerId);
          } else if (await this.refresh(containerId)) {
            this.stale.delete(containerId);
          } else {
            this.stale.add(containerId);
          }
        }
      }
      await this.claimUnclaimed();
      this.reconcile();
    } catch (e) {
      log.error("sampler.drain_failed", { host: this.currentHost().host.id, error: errorText(e) });
    }
  }

  /**
   * Reads one container into the cache. Returns false when the engine has not answered within the inspect timeout. The
   * cached entry is then kept, and the container is read again in the next round rather than right away: a retry in the
   * same drain would hold the queue for another timeout, and so on.
   */
  private async refresh(containerId: string): Promise<boolean> {
    const epoch = this.abort?.signal;
    if (!epoch) return true;
    const host = this.currentHost();
    const timeoutMs = this.options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS;
    const deadline = AbortSignal.any([epoch, AbortSignal.timeout(timeoutMs)]);
    try {
      const info = await untilAborted(host.runtime.inspectContainer(containerId, { signal: deadline }), deadline);
      if (this.started) this.containers.set(containerId, info);
    } catch (e) {
      if (epoch.aborted) return true;
      if (deadline.aborted) {
        log.warn("sampler.inspect_failed", {
          host: host.host.id,
          container: containerId,
          error: `no answer within ${timeoutMs} ms`,
        });
        return false;
      }
      if (isRuntimeError(e, "not_found")) this.containers.delete(containerId);
      else log.warn("sampler.inspect_failed", { host: host.host.id, container: containerId, error: errorText(e) });
    }
    return true;
  }

  /**
   * Reads again the containers whose inspect got no answer. Runs once per round, in the queue, and only while the
   * cache is current.
   */
  private async retryStale(): Promise<void> {
    if (this.stale.size === 0 || !this.ready()) return;
    for (const containerId of this.stale) {
      if (!this.dirty.has(containerId)) this.dirty.set(containerId, "refresh");
    }
    this.stale.clear();
    await this.drain();
  }

  /**
   * Lists the containers after a subscription, and marks the link live once the listing is in the cache. A listing that
   * does not answer within the list timeout fails the session, so the backoff in `run` retries it. Until then the reads
   * fall back to the engine.
   */
  private async resync(parent: AbortSignal): Promise<void> {
    const host = this.currentHost();
    const timeoutMs = this.options.listTimeoutMs ?? LIST_TIMEOUT_MS;
    const deadline = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
    let infos: ContainerInfo[];
    try {
      infos = await untilAborted(
        host.runtime.listContainers({ labels: { [host.keys.box]: "true" } }, { signal: deadline }),
        deadline,
      );
    } catch (e) {
      if (deadline.aborted && !parent.aborted) throw new Error(`no answer within ${timeoutMs} ms`, { cause: e });
      throw e;
    }
    if (!this.started) return;
    await this.adopt(infos);
    this.failures = 0;
    this.setState("live", null);
    this.reconcile();
    if (this.wanted()) void this.sampleRound();
  }

  /**
   * Lists the containers again while the link is up, and publishes what the listing changed. The listing runs outside
   * the queue, and a listing that does not answer in time is given up, so an engine that hangs holds up no write. It is
   * applied in the queue only if the cache took no change while it was listed: a change made meanwhile may be newer than
   * the listing, and the next re-list catches up. The link is left as it is: the event stream still decides whether it
   * is up, and this only catches up what that stream never reported.
   *
   * The deadline signal goes to the engine, so an adapter that honours it cancels the request. The guard against a
   * second listing lifts only when the listing itself settles: a listing that ignores the signal and never answers
   * keeps the guard, so the lists do not pile up behind it.
   */
  private async relist(): Promise<void> {
    const epoch = this.abort?.signal;
    if (!epoch || this.relisting || !this.ready()) return;
    const host = this.currentHost();
    const seen = this.changes;
    const timeoutMs = this.options.relistTimeoutMs ?? RELIST_TIMEOUT_MS;
    const deadline = AbortSignal.any([epoch, AbortSignal.timeout(timeoutMs)]);
    this.relisting = true;
    const listing = host.runtime.listContainers({ labels: { [host.keys.box]: "true" } }, { signal: deadline });
    const release = () => {
      this.relisting = false;
    };
    listing.then(release, release);
    try {
      const infos = await untilAborted(listing, deadline);
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
    }
  }

  /** Makes the cache hold exactly the listed containers, and gives a spec to each one that has none. */
  private async adopt(infos: ContainerInfo[]): Promise<void> {
    this.changes += 1;
    this.containers.clear();
    this.stale.clear();
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
   * A round that is queued or running already is returned instead of a second one.
   */
  private sampleRound(): Promise<void> {
    if (this.pendingRound) return this.pendingRound;
    const run: Promise<void> = this.rounds
      .then(() => this.round())
      .catch((e: unknown) =>
        log.error("sampler.round_failed", { host: this.currentHost().host.id, error: errorText(e) }),
      )
      .finally(() => {
        this.roundEndedAt = Date.now();
        if (this.pendingRound === run) this.pendingRound = null;
      });
    this.pendingRound = run;
    this.rounds = run;
    return run;
  }

  private staleMs(): number {
    return this.options.staleAfterMs ?? STALE_AFTER_MS;
  }

  /** True while a live subscriber watches, or a reader asked for samples within the lease. */
  private wanted(now = Date.now()): boolean {
    return this.watchers > 0 || now < this.needUntil;
  }

  private async round(): Promise<void> {
    const epoch = this.abort?.signal;
    const targets = await this.enqueue(async () => {
      await this.retryStale();
      return this.runningBoxes();
    });
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

  /** Runs a round whenever one is due and sampling is wanted, until the sampler stops. */
  private async sampleLoop(signal: AbortSignal): Promise<void> {
    while (await this.roundDue(signal)) {
      this.expedited = false;
      await this.sampleRound();
    }
  }

  /**
   * Resolves true when a round is due, and false once the sampler stops. While nothing is wanted the loop parks until a
   * watcher or a reader wakes it. A lease is waited out only up to its end, so the loop parks again once it runs out.
   */
  private async roundDue(signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted) {
      const now = Date.now();
      if (!this.wanted(now)) {
        await this.pause();
        continue;
      }
      const wait = this.roundEndedAt + this.cadence() - now;
      if (this.expedited || wait <= 0) return true;
      await this.pause(this.watchers > 0 ? wait : Math.min(wait, this.needUntil - now));
    }
    return false;
  }

  /**
   * Resolves after `ms`, or sooner when the loop is woken. Without `ms` it resolves only when woken. Only one wait is
   * pending at a time.
   */
  private pause(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(() => this.wakeLoop?.(), Math.max(0, ms));
      timer?.unref?.();
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
