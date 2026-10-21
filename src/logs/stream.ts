import { FrameBuffer } from "../events/frames";
import { HEARTBEAT_MS, PENDING_BYTES, PENDING_LIMIT, RETRY_MS } from "../events/stream";
import type { LogEvent, LogFollows, LogSubscription } from "../host/log-follow";

const HEARTBEAT = ": keep-alive\n\n";
const FRAMES_PER_CHUNK = 100;
const encoder = new TextEncoder();

export interface LogStreamOptions {
  /** The host's log follows. The stream subscribes to one box of them, so every stream of a box shares one follow. */
  readonly follows: LogFollows;
  readonly boxId: string;
  /** Lines the `sync` frames hold: the newest ones the feed has, at most this many. */
  readonly tail: number;
  readonly signal?: AbortSignal;
  /** Runs once when the stream ends: the signal aborted, the reader cancelled, or the box was removed. */
  readonly onEnd?: () => void;
  readonly pendingLimit?: number;
  readonly pendingBytes?: number;
  readonly heartbeatMs?: number;
}

const frame = (kind: string, data: unknown) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Server-sent events for the log of one box. The first frame is `sync`, which holds the newest lines the feed has, and
 * each new line follows as a `line` frame. A `sync` replaces what the client shows, so the stream sends one again
 * whenever it cannot send lines in order: when the box's container changed, and when a slow client overflowed its
 * queue, which is cleared first. A `closed` frame ends the stream when the box is removed.
 */
export function logStream(options: LogStreamOptions): ReadableStream<Uint8Array> {
  const { follows, boxId, tail, signal } = options;
  const frames = new FrameBuffer({
    frames: options.pendingLimit ?? PENDING_LIMIT,
    bytes: options.pendingBytes ?? PENDING_BYTES,
  });
  let subscription: LogSubscription | undefined;
  let done = false;
  let cancelled = false;
  let ending = false;
  let wake: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const syncFrame = (): string => {
    const lines = subscription?.snapshot(tail).map((line) => line.text) ?? [];
    const text = frame("sync", { lines });
    frames.raiseByteLimit(2 * Buffer.byteLength(text));
    return text;
  };

  const resync = () => {
    frames.clear();
    frames.force(syncFrame());
    notify();
  };

  const onLog = (event: LogEvent) => {
    if (done || ending) return;
    if (event.kind === "reset") {
      resync();
      return;
    }
    if (event.kind === "closed") {
      frames.clear();
      frames.force(frame("closed", {}));
      ending = true;
      notify();
      return;
    }
    if (frames.push(frame("line", { text: event.line.text }))) notify();
    else resync();
  };

  const stop = () => {
    if (done) return;
    done = true;
    subscription?.unsubscribe();
    subscription = undefined;
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", stop);
    options.onEnd?.();
    notify();
  };

  return new ReadableStream<Uint8Array>({
    start() {
      try {
        subscription = follows.subscribe(boxId, onLog);
        frames.force(`retry: ${RETRY_MS}\n\n`);
        frames.force(syncFrame());
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
        if (frames.length === 0 && !done && !ending) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (done) {
          if (!cancelled) controller.close();
          return;
        }
        if (frames.length > 0) {
          controller.enqueue(encoder.encode(frames.take(FRAMES_PER_CHUNK).join("")));
          return;
        }
        if (ending) {
          stop();
          controller.close();
        }
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
