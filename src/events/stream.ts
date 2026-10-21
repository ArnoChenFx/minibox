import { type EventFilter, matchesFilter, type StoredEvent } from "./store";

/** Events a reconnecting client is replayed at most. Beyond this the stream asks it to catch up on the list instead. */
export const REPLAY_LIMIT = 500;
/** Frames a client may leave unread. Past this the queue is dropped and the client is asked to catch up. */
export const PENDING_LIMIT = 1000;
export const HEARTBEAT_MS = 15_000;
/** The delay a browser waits before it reconnects after the connection drops. */
export const RETRY_MS = 3000;

const HEARTBEAT = ": keep-alive\n\n";
const FRAMES_PER_CHUNK = 100;
const encoder = new TextEncoder();

export interface StreamStore {
  after(seq: number, filter: EventFilter, limit: number): StoredEvent[];
  head(): number;
}

/**
 * The live state a stream carries next to the stored events. Its frames have no `id:`, so a reconnect replays only the
 * stored events and gets the state again from a new `sync` frame.
 */
export interface LiveSource {
  /** The frame that starts a client from the current state. Sent first, and again after the stream has overflowed. */
  sync(): string;
  /** Subscribes `send` to the live frames and returns the function that removes the subscription. */
  subscribe(send: (frame: string) => void): () => void;
}

export interface EventStreamOptions {
  readonly store: StreamStore;
  /** Registers a listener for live events and returns the function that removes it. */
  readonly subscribe: (listener: (event: StoredEvent) => void) => () => void;
  readonly filter: EventFilter;
  /** The `Last-Event-ID` of a reconnecting client: the sequence number of the last event it received. */
  readonly lastId?: number;
  readonly signal?: AbortSignal;
  /** Runs once when the stream ends, whether the signal aborted or the reader cancelled. */
  readonly onEnd?: () => void;
  readonly live?: LiveSource;
  readonly replayLimit?: number;
  readonly pendingLimit?: number;
  readonly heartbeatMs?: number;
}

const eventFrame = (event: StoredEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
const resetFrame = (after: number) => `event: reset\ndata: ${JSON.stringify({ after })}\n\n`;

/**
 * Server-sent events for the stored events that match the filter. The listener is attached before the replay is read,
 * and every live event is checked against the last sequence number already sent, so nothing is lost or sent twice. A
 * `reset` event means the client missed events the stream could not send: it reads the list endpoint for them, then
 * carries on from the stream. When the stream has live state, its frames come after the first `sync` and are never
 * dropped one by one: an overflow clears the queue, then sends a `reset` and a fresh `sync`.
 */
export function eventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const { store, filter, signal, live } = options;
  const replayLimit = options.replayLimit ?? REPLAY_LIMIT;
  const pendingLimit = options.pendingLimit ?? PENDING_LIMIT;
  const frames: string[] = [];
  let last = 0;
  let done = false;
  let cancelled = false;
  let wake: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeLive: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const queue = (frame: string) => {
    frames.push(frame);
    notify();
  };

  const overflow = () => {
    frames.length = 0;
    queue(resetFrame(last));
    if (live) queue(live.sync());
  };

  const onLive = (event: StoredEvent) => {
    if (done || event.seq <= last) return;
    last = event.seq;
    if (!matchesFilter(event, filter)) return;
    if (frames.length >= pendingLimit) {
      overflow();
      return;
    }
    queue(eventFrame(event));
  };

  const onState = (frame: string) => {
    if (done) return;
    if (frames.length >= pendingLimit) overflow();
    else queue(frame);
  };

  const stop = () => {
    if (done) return;
    done = true;
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeLive?.();
    unsubscribeLive = undefined;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", stop);
    options.onEnd?.();
    notify();
  };

  return new ReadableStream<Uint8Array>({
    start() {
      unsubscribe = options.subscribe(onLive);
      frames.push(`retry: ${RETRY_MS}\n\n`);
      unsubscribeLive = live?.subscribe(onState);
      if (options.lastId !== undefined) {
        const missed = store.after(options.lastId, filter, replayLimit + 1);
        if (missed.length > replayLimit) frames.push(resetFrame(store.head()));
        else for (const event of missed) frames.push(eventFrame(event));
      }
      if (live) frames.push(live.sync());
      last = store.head();
      heartbeat = setInterval(() => {
        if (frames.length < pendingLimit) queue(HEARTBEAT);
      }, options.heartbeatMs ?? HEARTBEAT_MS);
      heartbeat.unref();
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop);
    },
    async pull(controller) {
      if (frames.length === 0 && !done) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (done) {
        if (!cancelled) controller.close();
        return;
      }
      if (frames.length > 0) controller.enqueue(encoder.encode(frames.splice(0, FRAMES_PER_CHUNK).join("")));
    },
    cancel() {
      cancelled = true;
      stop();
    },
  });
}
