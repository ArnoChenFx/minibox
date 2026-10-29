import type { StoredEvent } from "../events/store";
import type { AuditNote } from "../events/types";
import { ulid } from "../events/ulid";
import type { LinkFrame } from "../host/live";
import { log } from "../lib/logger";
import { type Outgoing, outgoingFor, subscribes } from "./channels";
import { noticeOfEvent } from "./rules";
import type { NotifyStore } from "./store";
import { DeliveryError, type SendOptions, send } from "./transport";
import { type Notice, TEST_KIND, type StoredChannel } from "./types";

const TELEGRAM_API = "https://api.telegram.org";
const RETRYABLE = new Set(["timeout", "network", "dns_failed"]);
const TITLE_MAX = 200;
const BODY_MAX = 500;
const LAST_SENT_MAX = 1000;

/** Defaults a test or an operator may override. Retries stop at `maxAttempts`, so a dead endpoint costs a bounded number of sends. */
const NOTIFY_DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  backoffCapMs: 30_000,
  dedupMs: 5 * 60_000,
  maxQueue: 256,
  concurrency: 4,
} as const;

export interface NotificationsOptions {
  readonly store: NotifyStore;
  readonly version: string;
  /** Whether a channel may send to an address that is not public. Set by NOTIFY_ALLOW_PRIVATE. */
  readonly allowPrivate: boolean;
  /** Writes a delivery record. The app points it at the event log under the local host. */
  readonly record: (note: AuditNote) => void;
  /** Removes known secrets from the text a notice carries, such as the access key. */
  readonly redact?: (text: string) => string;
  readonly telegramBase?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly dedupMs?: number;
  readonly maxQueue?: number;
  readonly concurrency?: number;
  /** Sends one request and returns its status. Tests pass a fake, so no channel is reached. */
  readonly transport?: (request: Outgoing, options: SendOptions) => Promise<number>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface TestResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly attempts: number;
  readonly error: string | null;
}

interface Attempt {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
  readonly retryable: boolean;
}

interface Job {
  readonly channel: StoredChannel;
  readonly notice: Notice;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The wait before the next attempt: 1 s, 2 s, 4 s and so on, up to the cap. */
export function backoffMs(attempt: number, cap: number = NOTIFY_DEFAULTS.backoffCapMs): number {
  return Math.min(cap, 1000 * 2 ** (attempt - 1));
}

function defaultKey(notice: Notice): string {
  return `${notice.kind}:${notice.box?.name ?? notice.host ?? ""}`;
}

/**
 * Turns events and host state into notices and sends them. `notify` only queues, so an operation that causes a notice
 * never waits for a channel. Each send is bounded by a timeout and by a fixed number of attempts, and every outcome is
 * recorded as a `notify.deliver` event, which is what the delivery list reads.
 */
export class Notifications {
  /** The channels and their settings. The operations that configure channels read and change them here. */
  readonly store: NotifyStore;
  private readonly queue: Job[] = [];
  private active = 0;
  private stopped = false;
  private readonly lastSent = new Map<string, number>();
  private readonly linkStates = new Map<string, LinkFrame["state"]>();
  private idleWaiters: (() => void)[] = [];
  private readonly settings: {
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly dedupMs: number;
    readonly maxQueue: number;
    readonly concurrency: number;
  };

  constructor(private readonly options: NotificationsOptions) {
    this.store = options.store;
    this.settings = {
      timeoutMs: options.timeoutMs ?? NOTIFY_DEFAULTS.timeoutMs,
      maxAttempts: options.maxAttempts ?? NOTIFY_DEFAULTS.maxAttempts,
      dedupMs: options.dedupMs ?? NOTIFY_DEFAULTS.dedupMs,
      maxQueue: options.maxQueue ?? NOTIFY_DEFAULTS.maxQueue,
      concurrency: options.concurrency ?? NOTIFY_DEFAULTS.concurrency,
    };
  }

  /**
   * Queues a notice for every channel that subscribes to it and has not been sent it within the dedup window. Returns
   * before any channel is reached, and never throws: a notice that cannot be queued is logged, and the caller carries on.
   */
  notify(notice: Notice): void {
    if (this.stopped) return;
    try {
      const now = this.now();
      const safe = this.sanitize(notice);
      const key = safe.dedupKey ?? defaultKey(safe);
      for (const channel of this.options.store.list()) {
        if (!subscribes(channel, safe)) continue;
        const slot = `${channel.id}\u0000${key}`;
        const last = this.lastSent.get(slot);
        if (last !== undefined && now - last < this.settings.dedupMs) continue;
        this.lastSent.set(slot, now);
        this.enqueue({ channel, notice: safe });
      }
      this.forget(now);
    } catch (e) {
      log.error("notify.failed", { kind: notice.kind, error: String(e) });
    }
  }

  /** The notice an event calls for, if any. Called for every stored event, so it does no I/O. */
  onEvent(event: StoredEvent): void {
    try {
      const notice = noticeOfEvent(event);
      if (notice) this.notify(notice);
    } catch (e) {
      log.error("notify.failed", { op: event.op, error: String(e) });
    }
  }

  /** A host that was live and is now down is an outage. A host first seen down is not, so a restart does not notify. */
  onLink(frame: LinkFrame): void {
    const previous = this.linkStates.get(frame.hostId);
    this.linkStates.set(frame.hostId, frame.state);
    if (frame.state !== "down" || previous !== "live") return;
    const at = Date.parse(frame.at);
    this.notify({
      kind: "host.offline",
      title: `Host ${frame.hostId} is offline`,
      body: frame.error ?? undefined,
      host: frame.hostId,
      at: Number.isFinite(at) ? at : this.now(),
    });
  }

  /**
   * Sends one test notice on a channel and waits for the answer. A single attempt, with no dedup, so the answer is the
   * first try. The outcome is recorded through `record`, under the operation that asked for it.
   */
  async test(channelId: string, record: (note: AuditNote) => void = this.options.record): Promise<TestResult> {
    const channel = this.options.store.get(channelId);
    if (!channel) throw new Error(`no notification channel ${channelId}`);
    const now = this.now();
    const notice: Notice = {
      kind: TEST_KIND,
      title: "MiniBox test notification",
      body: `Checks that the ${channel.name} channel reaches you.`,
      at: now,
    };
    const id = ulid(now);
    const outcome = await this.attempt(channel, notice, id);
    this.report(channel, notice, id, { ...outcome, attempts: 1 }, record);
    return { ok: outcome.ok, status: outcome.status, attempts: 1, error: outcome.error };
  }

  /** Resolves once nothing is queued or in flight. Tests wait on it; the server never does. */
  idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Drops what is queued and stops sending. A send already in flight ends by its own timeout. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.settleIdle();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sanitize(notice: Notice): Notice {
    const redact = this.options.redact ?? ((text: string) => text);
    return {
      ...notice,
      title: redact(notice.title).slice(0, TITLE_MAX),
      body: notice.body === undefined ? undefined : redact(notice.body).slice(0, BODY_MAX),
    };
  }

  private enqueue(job: Job): void {
    if (this.queue.length >= this.settings.maxQueue) {
      this.report(
        job.channel,
        job.notice,
        ulid(this.now()),
        { ok: false, status: null, attempts: 0, error: "queue_full", retryable: false },
        this.options.record,
      );
      return;
    }
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.settings.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.active += 1;
      this.run(job)
        .catch((e: unknown) => log.error("notify.failed", { channel: job.channel.id, error: String(e) }))
        .finally(() => {
          this.active -= 1;
          this.pump();
          this.settleIdle();
        });
    }
  }

  private async run(job: Job): Promise<void> {
    const id = ulid(this.now());
    let attempts = 0;
    let last: Attempt = { ok: false, status: null, error: "stopped", retryable: false };
    while (!this.stopped) {
      attempts += 1;
      last = await this.attempt(job.channel, job.notice, id);
      if (last.ok || !last.retryable || attempts >= this.settings.maxAttempts) break;
      await (this.options.sleep ?? pause)(backoffMs(attempts));
    }
    this.report(job.channel, job.notice, id, { ...last, attempts }, this.options.record);
  }

  private async attempt(channel: StoredChannel, notice: Notice, id: string): Promise<Attempt> {
    try {
      const request = outgoingFor(channel, this.options.store.secret(channel.id), notice, {
        id,
        version: this.options.version,
        timestamp: Math.floor(this.now() / 1000),
        telegramBase: this.options.telegramBase ?? TELEGRAM_API,
      });
      const transport = this.options.transport ?? send;
      const status = await transport(request, {
        allowPrivate: this.options.allowPrivate,
        timeoutMs: this.settings.timeoutMs,
      });
      if (status >= 200 && status < 300) return { ok: true, status, error: null, retryable: false };
      return { ok: false, status, error: `http_${status}`, retryable: status === 429 || status >= 500 };
    } catch (e) {
      const code = e instanceof DeliveryError ? e.code : "unexpected";
      if (code === "unexpected")
        log.error("notify.unexpected", { channel: channel.id, error: e instanceof Error ? e.name : "unknown" });
      return {
        ok: false,
        status: e instanceof DeliveryError ? e.status : null,
        error: code,
        retryable: RETRYABLE.has(code),
      };
    }
  }

  private report(
    channel: StoredChannel,
    notice: Notice,
    id: string,
    outcome: Attempt & { readonly attempts: number },
    record: (note: AuditNote) => void,
  ): void {
    try {
      record({
        op: "notify.deliver",
        kind: "write",
        status: outcome.ok ? "ok" : "error",
        summary: outcome.ok ? `Notification sent: ${channel.name}` : `Notification failed: ${channel.name}`,
        target: { kind: "notify", id: channel.id, name: channel.name },
        detail: {
          delivery: id,
          notice: notice.kind,
          channel: channel.id,
          type: channel.type,
          attempts: outcome.attempts,
          httpStatus: outcome.status,
          error: outcome.error,
          title: notice.title,
        },
        error: outcome.ok ? undefined : { code: "delivery_failed", status: 502 },
      });
    } catch (e) {
      log.error("notify.record_failed", { channel: channel.id, error: String(e) });
    }
  }

  private forget(now: number): void {
    if (this.lastSent.size <= LAST_SENT_MAX) return;
    for (const [slot, sent] of this.lastSent) {
      if (now - sent >= this.settings.dedupMs) this.lastSent.delete(slot);
    }
  }

  private settleIdle(): void {
    if (this.active !== 0 || this.queue.length !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
