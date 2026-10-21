import { FrameBuffer } from "./frames";
import { type EventFilter, matchesFilter, type StoredEvent } from "./store";

/** Events a reconnecting client is replayed at most. Beyond this the stream asks it to catch up on the list instead. */
export const REPLAY_LIMIT = 500;
/** Frames a client may leave unread. Past this the queue is dropped and the client is asked to catch up. */
export const PENDING_LIMIT = 1000;
/**
 * Bytes a client may leave unread. Past this the queue is dropped, as it is past PENDING_LIMIT frames. A sync frame
 * larger than this raises the limit to twice its size, so the frames after it still fit.
 */
export const PENDING_BYTES = 1024 * 1024;
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
  /**
   * Subscribes `send` to the live frames and returns the function that removes the subscription. A frame with a key
   * replaces the frame still queued under the same key, so a slow client is sent only the latest of that frame.
   */
  subscribe(send: (frame: string, key?: string) => void): () => void;
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
  readonly pendingBytes?: number;
  readonly heartbeatMs?: number;
}

const eventFrame = (event: StoredEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
const resetFrame = (after: number) => `event: reset\ndata: ${JSON.stringify({ after })}\n\n`;

/**
 * Server-sent events for the stored events that match the filter. The listener is attached before the replay is read,
 * and every live event is checked against the last sequence number already sent, so nothing is lost or sent twice. A
 * `reset` event means the client missed events the stream could not send: it reads the list endpoint for them, then
 * carries on from the stream. When the stream has live state, its frames come after the first `sync` and are never
 * dropped one by one: an overflow clears the queue, then sends a `reset` and a fresh `sync`. A slow client's queue is
 * bounded by frames and by bytes, and a keyed live frame replaces the one still queued under its key.
 */
export function eventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const { store, filter, signal, live } = options;
  const replayLimit = options.replayLimit ?? REPLAY_LIMIT;
  const frames = new FrameBuffer({
    frames: options.pendingLimit ?? PENDING_LIMIT,
    bytes: options.pendingBytes ?? PENDING_BYTES,
  });
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

  const forceSync = () => {
    if (!live) return;
    const sync = live.sync();
    frames.raiseByteLimit(2 * Buffer.byteLength(sync));
    frames.force(sync);
  };

  const overflow = () => {
    frames.clear();
    frames.force(resetFrame(last));
    forceSync();
    notify();
  };

  const onLive = (event: StoredEvent) => {
    if (done || event.seq <= last) return;
    last = event.seq;
    if (!matchesFilter(event, filter)) return;
    if (frames.push(eventFrame(event))) notify();
    else overflow();
  };

  const onState = (frame: string, key?: string) => {
    if (done) return;
    if (frames.push(frame, key)) notify();
    else overflow();
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
      try {
        unsubscribe = options.subscribe(onLive);
        frames.force(`retry: ${RETRY_MS}\n\n`);
        unsubscribeLive = live?.subscribe(onState);
        if (options.lastId !== undefined) {
          const missed = store.after(options.lastId, filter, replayLimit + 1);
          if (missed.length > replayLimit) frames.force(resetFrame(store.head()));
          else for (const event of missed) frames.force(eventFrame(event));
        }
        forceSync();
        last = store.head();
        heartbeat = setInterval(() => {
          if (frames.push(HEARTBEAT)) notify();
        }, options.heartbeatMs ?? HEARTBEAT_MS);
        heartbeat.unref();
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop);
      } catch (e) {
        stop();
        throw e;
      }
    },
    async pull(controller) {
      try {
        if (frames.length === 0 && !done) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (done) {
          if (!cancelled) controller.close();
          return;
        }
        if (frames.length > 0) controller.enqueue(encoder.encode(frames.take(FRAMES_PER_CHUNK).join("")));
      } catch (e) {
        stop();
        throw e;
      }
    },
    cancel() {
      cancelled = true;
      stop();
    },
  });
}
