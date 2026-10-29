import { sleep } from "../lib/abort";
import { log } from "../lib/logger";
import { LIMITS } from "../lib/validation";
import { isRuntimeError, type Runtime } from "../runtime";

/** Lines a box's feed holds: the most a stream may ask for, so any tail a client asks for is there to send. */
export const LOG_RING_LINES = LIMITS.maxLogTail;
/** Bytes a box's feed holds. A box whose lines are long keeps fewer of them. */
export const LOG_RING_BYTES = 2 * 1024 * 1024;
/**
 * How far before the newest line a resumed follow starts. The engine stamps stdout and stderr lines a few microseconds
 * apart, and they can reach the log out of order, so a resume reads this far back and drops the lines it already sent.
 */
const RESUME_WINDOW_MS = 1000;
/** How long a box's follow runs after its last subscriber leaves, so a reader that comes back at once finds the feed. */
const LOG_LEASE_MS = 30_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z /;

/** The stamp of a line the engine wrote with timestamps, in nanoseconds since the epoch. Null for a line without one. */
export function stampNanos(text: string): bigint | null {
  const match = STAMP.exec(text);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(ms)) return null;
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

/** A line of a box's log as its feed holds it. `text` is the line as the engine sent it, stamp included. */
export interface LogLine {
  readonly seq: number;
  readonly text: string;
  readonly nanos: bigint | null;
}

/**
 * What a subscriber hears. `line` is a new line. `reset` means the box now runs a different container, so the lines held
 * before are not its lines any more. `closed` means the box was removed and its follow has ended for good. `stopped`
 * means the host stopped its follows while the box still exists, so a subscriber should read it again later.
 */
export type LogEvent =
  | { readonly kind: "line"; readonly line: LogLine }
  | { readonly kind: "reset" }
  | { readonly kind: "closed" }
  | { readonly kind: "stopped" };

export type LogListener = (event: LogEvent) => void;

export interface LogSubscription {
  /** The newest `tail` lines held, oldest first. */
  snapshot(tail: number): LogLine[];
  unsubscribe(): void;
}

/** Where the feeds read from: the host's runtime, the container a box runs in, and whether the host's cache is current. */
export interface LogSource {
  runtime(): Runtime;
  target(boxId: string): { containerId: string; running: boolean } | null;
  ready(): boolean;
}

export interface LogFollowOptions {
  leaseMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

interface Feed {
  readonly boxId: string;
  containerId: string | null;
  /** True once the container's log was read to its end while the cache showed it stopped. It is read again once it runs. */
  drained: boolean;
  lines: LogLine[];
  bytes: number;
  next: number;
  /** The stamp of the newest line delivered, or null before any. */
  newest: bigint | null;
  /** The stamp of the newest line the ring has dropped for its size, or null. A resumed follow sends none of those again. */
  trimmed: bigint | null;
  /**
   * While a resumed follow may send lines again: how many of each line already sent it may send again, and the stamp past
   * which no line is a replay. A count, not a set, so two lines that match exactly are both held back only once each.
   */
  overlap: { until: bigint; texts: Map<string, number> } | null;
  readonly listeners: Set<LogListener>;
  /** Ends the box's follow loop. Null while no loop runs. */
  loop: AbortController | null;
  /** Ends the engine read in flight. */
  read: AbortController | null;
  /** Resumes a loop that waits for the cache to change. */
  wake: (() => void) | null;
  lease: ReturnType<typeof setTimeout> | null;
}

/**
 * The log lines of each box a subscriber reads, held for the host. A box has one follow of its container while it has
 * subscribers, however many there are. Each follow holds the newest lines in a ring, so a subscriber that arrives gets
 * the lines it asks for without a call to the engine, and every line reaches each subscriber once.
 *
 * A follow ends when its container stops, and starts again when the cache shows it running. When the engine drops a
 * follow of a running container, the follow resumes from the newest line held: the engine returns the lines from there
 * on, and the lines already sent are dropped by their text. A follow with no subscriber lasts for `leaseMs` more.
 */
export class LogFollows {
  private readonly feeds = new Map<string, Feed>();
  private readonly leaseMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly source: LogSource,
    options: LogFollowOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? LOG_LEASE_MS;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  }

  /**
   * Subscribes `listener` to a box's new lines. The first subscriber starts the box's follow. The snapshot the caller
   * takes right after this call holds the lines before the first `line` event, with nothing between the two.
   */
  subscribe(boxId: string, listener: LogListener): LogSubscription {
    const feed = this.feedOf(boxId);
    feed.listeners.add(listener);
    if (feed.lease) clearTimeout(feed.lease);
    feed.lease = null;
    this.ensure(feed);
    return {
      snapshot: (tail) => (tail > 0 ? feed.lines.slice(-tail) : []),
      unsubscribe: () => this.release(feed, listener),
    };
  }

  /** Called after each change to the host's cache. Each follow starts, restarts, or waits to match the cache again. */
  changed(): void {
    const ready = this.source.ready();
    for (const feed of this.feeds.values()) {
      const target = ready ? this.source.target(feed.boxId) : null;
      if (feed.read && target?.containerId !== feed.containerId) feed.read.abort();
      this.ensure(feed);
      feed.wake?.();
    }
  }

  /** The box is gone. Its subscribers hear that, and its follow ends. */
  close(boxId: string): void {
    const feed = this.feeds.get(boxId);
    if (!feed) return;
    this.feeds.delete(boxId);
    this.emit(feed, { kind: "closed" });
    this.stopFeed(feed);
  }

  /** The host has stopped. Every feed ends. Its boxes still exist, so subscribers hear `stopped`, not `closed`. */
  stop(): void {
    for (const feed of Array.from(this.feeds.values())) {
      this.feeds.delete(feed.boxId);
      this.emit(feed, { kind: "stopped" });
      this.stopFeed(feed);
    }
  }

  private feedOf(boxId: string): Feed {
    let feed = this.feeds.get(boxId);
    if (!feed) {
      feed = {
        boxId,
        containerId: null,
        drained: false,
        lines: [],
        bytes: 0,
        next: 1,
        newest: null,
        trimmed: null,
        overlap: null,
        listeners: new Set(),
        loop: null,
        read: null,
        wake: null,
        lease: null,
      };
      this.feeds.set(boxId, feed);
    }
    return feed;
  }

  private release(feed: Feed, listener: LogListener): void {
    if (!feed.listeners.delete(listener) || feed.listeners.size > 0) return;
    if (this.feeds.get(feed.boxId) !== feed) return;
    feed.lease = setTimeout(() => {
      feed.lease = null;
      this.drop(feed);
    }, this.leaseMs);
    feed.lease.unref?.();
  }

  private drop(feed: Feed): void {
    if (this.feeds.get(feed.boxId) !== feed || feed.listeners.size > 0) return;
    this.feeds.delete(feed.boxId);
    this.stopFeed(feed);
  }

  private stopFeed(feed: Feed): void {
    if (feed.lease) clearTimeout(feed.lease);
    feed.lease = null;
    feed.loop?.abort();
    feed.read?.abort();
    feed.wake?.();
  }

  private ensure(feed: Feed): void {
    if (feed.loop) return;
    const loop = new AbortController();
    feed.loop = loop;
    this.run(feed, loop.signal)
      .catch((e: unknown) => log.error("logs.follow_crashed", { box: feed.boxId, error: errorText(e) }))
      .finally(() => {
        if (feed.loop === loop) feed.loop = null;
      });
  }

  private async run(feed: Feed, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const target = this.source.ready() ? this.source.target(feed.boxId) : null;
      if (!target) {
        await this.park(feed, signal);
        continue;
      }
      if (feed.containerId !== target.containerId) this.adopt(feed, target.containerId);
      if (target.running) feed.drained = false;
      else if (feed.drained) {
        await this.park(feed, signal);
        continue;
      }

      const read = new AbortController();
      const stopRead = () => read.abort();
      feed.read = read;
      signal.addEventListener("abort", stopRead, { once: true });
      let received = 0;
      let failed = false;
      let failure: unknown;
      try {
        const since = this.resumeFrom(feed);
        const lines = this.source.runtime().followLogs(target.containerId, {
          tail: LOG_RING_LINES,
          timestamps: true,
          since,
          signal: read.signal,
        });
        for await (const text of lines) {
          received += 1;
          this.receive(feed, text);
        }
      } catch (e) {
        failed = true;
        failure = e;
      } finally {
        signal.removeEventListener("abort", stopRead);
        feed.read = null;
      }

      if (signal.aborted) return;
      if (read.signal.aborted) continue;
      if (!failed) {
        if (received > 0) failures = 0;
        if (!this.runs(feed)) {
          feed.drained = !target.running;
          await this.park(feed, signal);
          continue;
        }
        failures += 1;
        await sleep(this.delay(failures), signal);
        continue;
      }
      if (isRuntimeError(failure, "not_found")) {
        await this.park(feed, signal);
        continue;
      }
      failures += 1;
      log.warn("logs.follow_failed", { box: feed.boxId, error: errorText(failure), retryInMs: this.delay(failures) });
      await sleep(this.delay(failures), signal);
    }
  }

  /** Waits until `changed` or the end of the loop. */
  private park(feed: Feed, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        feed.wake = null;
        signal.removeEventListener("abort", done);
        resolve();
      };
      feed.wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private runs(feed: Feed): boolean {
    const target = this.source.ready() ? this.source.target(feed.boxId) : null;
    return target !== null && target.running && target.containerId === feed.containerId;
  }

  private delay(failures: number): number {
    return Math.min(this.retryMaxMs, this.retryMinMs * 2 ** Math.max(0, failures - 1));
  }

  /** A new container starts a new log: the lines held are not its lines, so subscribers are told to read it again. */
  private adopt(feed: Feed, containerId: string): void {
    if (feed.containerId !== null) {
      feed.lines = [];
      feed.bytes = 0;
      feed.newest = null;
      feed.trimmed = null;
      feed.overlap = null;
      this.emit(feed, { kind: "reset" });
    }
    feed.containerId = containerId;
    feed.drained = false;
  }

  /**
   * The `since` of a follow that resumes the feed. It starts `RESUME_WINDOW_MS` before the newest line held, and the
   * lines in that window are remembered so the resumed follow drops the ones already sent. Without a line held, the
   * follow reads the tail and nothing is dropped.
   */
  private resumeFrom(feed: Feed): Date | undefined {
    if (feed.newest === null) return undefined;
    const cutoffMs = Number(feed.newest / 1_000_000n) - RESUME_WINDOW_MS;
    const from = BigInt(cutoffMs) * 1_000_000n;
    const texts = new Map<string, number>();
    for (const line of feed.lines) {
      if (line.nanos !== null && line.nanos >= from) texts.set(line.text, (texts.get(line.text) ?? 0) + 1);
    }
    feed.overlap = { until: feed.newest, texts };
    return new Date(cutoffMs);
  }

  /** Takes one of the replays counted for `text`. False once none is left, so the line is new. */
  private replayed(texts: Map<string, number>, text: string): boolean {
    const left = texts.get(text) ?? 0;
    if (left === 0) return false;
    if (left === 1) texts.delete(text);
    else texts.set(text, left - 1);
    return true;
  }

  private receive(feed: Feed, text: string): void {
    const nanos = stampNanos(text);
    if (feed.overlap) {
      if (nanos !== null && nanos > feed.overlap.until) feed.overlap = null;
      else if (
        (feed.trimmed !== null && nanos !== null && nanos <= feed.trimmed) ||
        this.replayed(feed.overlap.texts, text)
      )
        return;
    }
    const line: LogLine = { seq: feed.next, text, nanos };
    feed.next += 1;
    feed.lines.push(line);
    feed.bytes += Buffer.byteLength(text);
    while (feed.lines.length > 0 && (feed.lines.length > LOG_RING_LINES || feed.bytes > LOG_RING_BYTES)) {
      const oldest = feed.lines.shift();
      if (!oldest) break;
      feed.bytes -= Buffer.byteLength(oldest.text);
      if (oldest.nanos !== null && (feed.trimmed === null || oldest.nanos > feed.trimmed)) feed.trimmed = oldest.nanos;
    }
    if (nanos !== null && (feed.newest === null || nanos > feed.newest)) feed.newest = nanos;
    this.emit(feed, { kind: "line", line });
  }

  /** Calls the listeners that are subscribed now. One that subscribes during the call already holds this event. */
  private emit(feed: Feed, event: LogEvent): void {
    const listeners = Array.from(feed.listeners);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (e) {
        log.error("logs.listener_failed", { box: feed.boxId, error: errorText(e) });
      }
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
