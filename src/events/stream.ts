import { HEARTBEAT_MS, PENDING_BYTES, PENDING_LIMIT, RETRY_MS, sseStream } from "./sse-body";
import { type EventFilter, matchesFilter, type StoredEvent } from "./store";

export { HEARTBEAT_MS, PENDING_BYTES, PENDING_LIMIT, RETRY_MS };

/** Events a reconnecting client is replayed at most. Beyond this the stream asks it to catch up on the list instead. */
export const REPLAY_LIMIT = 500;

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
  const { store, filter, live } = options;
  const replayLimit = options.replayLimit ?? REPLAY_LIMIT;
  let last = 0;

  return sseStream(options, (shell) => {
    const { frames, notify, onStop } = shell;

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
      if (shell.done || event.seq <= last) return;
      last = event.seq;
      if (!matchesFilter(event, filter)) return;
      if (frames.push(eventFrame(event))) notify();
      else overflow();
    };

    const onState = (frame: string, key?: string) => {
      if (shell.done) return;
      if (frames.push(frame, key)) notify();
      else overflow();
    };

    return {
      attach: () => options.subscribe(onLive),
      begin: () => {
        const unsubscribeLive = live?.subscribe(onState);
        if (unsubscribeLive) onStop(unsubscribeLive);
        if (options.lastId !== undefined) {
          const missed = store.after(options.lastId, filter, replayLimit + 1);
          if (missed.length > replayLimit) frames.force(resetFrame(store.head()));
          else for (const event of missed) frames.force(eventFrame(event));
        }
        forceSync();
        last = store.head();
      },
    };
  });
}
