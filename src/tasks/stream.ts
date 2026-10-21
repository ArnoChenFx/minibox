import { FrameBuffer } from "../events/frames";
import { HEARTBEAT_MS, PENDING_BYTES, PENDING_LIMIT, REPLAY_LIMIT, RETRY_MS } from "../events/stream";
import type { TaskStreamEvent } from "./types";

const HEARTBEAT = ": keep-alive\n\n";
const FRAMES_PER_CHUNK = 100;
const encoder = new TextEncoder();

export interface TaskEventSource {
  after(taskId: string, after: number, limit: number): TaskStreamEvent[];
  oldest(taskId: string): number;
  head(taskId: string): number;
}

export interface TaskStreamOptions {
  readonly taskId: string;
  readonly store: TaskEventSource;
  /** Registers a listener for live task events and returns the function that removes it. */
  readonly subscribe: (listener: (event: TaskStreamEvent) => void) => () => void;
  /** Replay events with a cursor greater than this. A first connection omits it and receives only what happens next. */
  readonly after?: number;
  readonly signal?: AbortSignal;
  /** Runs once when the stream ends, whether the signal aborted or the reader cancelled. */
  readonly onEnd?: () => void;
  readonly replayLimit?: number;
  readonly pendingLimit?: number;
  readonly pendingBytes?: number;
  readonly heartbeatMs?: number;
}

const eventFrame = (event: TaskStreamEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
const resetFrame = (after: number) => `event: reset\ndata: ${JSON.stringify({ after })}\n\n`;

/**
 * Server-sent events for one task. The listener is attached before any replay, and a cursor already sent is not sent
 * again. A `reset` event means the client missed log the stream no longer has: it reads the task for the retained
 * output, then carries on. A slow client's queue is bounded by frames and by bytes, as the event stream's is. Heartbeats
 * keep proxies from closing the stream; Bun's own idle timer is disabled by the route (`server.timeout(req, 0)`), because
 * writes do not extend it.
 */
export function taskStream(options: TaskStreamOptions): ReadableStream<Uint8Array> {
  const { taskId, store, signal } = options;
  const replayLimit = options.replayLimit ?? REPLAY_LIMIT;
  const frames = new FrameBuffer({
    frames: options.pendingLimit ?? PENDING_LIMIT,
    bytes: options.pendingBytes ?? PENDING_BYTES,
  });
  const sent = new Set<number>();
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

  const queueEvent = (event: TaskStreamEvent) => {
    if (sent.has(event.seq)) return;
    sent.add(event.seq);
    last = Math.max(last, event.seq);
    if (!frames.push(eventFrame(event))) {
      frames.clear();
      frames.force(resetFrame(last));
    }
    notify();
  };

  const onLive = (event: TaskStreamEvent) => {
    if (done || event.taskId !== taskId || event.seq <= last) return;
    queueEvent(event);
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
      try {
        unsubscribe = options.subscribe(onLive);
        frames.force(`retry: ${RETRY_MS}\n\n`);
        if (options.after !== undefined) {
          const oldest = store.oldest(taskId);
          const missed = store.after(taskId, options.after, replayLimit + 1);
          if (oldest > options.after + 1 || missed.length > replayLimit) frames.force(resetFrame(store.head(taskId)));
          else for (const event of missed) queueEvent(event);
        }
        last = Math.max(last, store.head(taskId));
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
    },
    cancel() {
      cancelled = true;
      stop();
    },
  });
}
