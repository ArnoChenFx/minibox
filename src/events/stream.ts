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
 * carries on from the stream.
 */
export function eventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const { store, filter, signal } = options;
  const replayLimit = options.replayLimit ?? REPLAY_LIMIT;
  const pendingLimit = options.pendingLimit ?? PENDING_LIMIT;
  const frames: string[] = [];
  let last = 0;
  let done = false;
  let cancelled = false;
  let wake: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const queue = (frame: string) => {
    frames.push(frame);
    notify();
  };

  const onLive = (event: StoredEvent) => {
    if (done || event.seq <= last) return;
    last = event.seq;
    if (!matchesFilter(event, filter)) return;
    if (frames.length >= pendingLimit) {
      frames.length = 0;
      queue(resetFrame(last));
      return;
    }
    queue(eventFrame(event));
  };

  const stop = () => {
    if (done) return;
    done = true;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", stop);
    options.onEnd?.();
    notify();
  };

  return new ReadableStream<Uint8Array>({
    start() {
      unsubscribe = options.subscribe(onLive);
      frames.push(`retry: ${RETRY_MS}\n\n`);
      if (options.lastId !== undefined) {
        const missed = store.after(options.lastId, filter, replayLimit + 1);
        if (missed.length > replayLimit) frames.push(resetFrame(store.head()));
        else for (const event of missed) frames.push(eventFrame(event));
      }
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
