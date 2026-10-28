import { FrameBuffer } from "./frames";

export const HEARTBEAT_MS = 15_000;
/** The delay a browser waits before it reconnects after the connection drops. */
export const RETRY_MS = 3000;
/** Frames a client may leave unread. Past this the queue is dropped and the client is asked to catch up. */
export const PENDING_LIMIT = 1000;
/**
 * Bytes a client may leave unread. Past this the queue is dropped, as it is past PENDING_LIMIT frames. A sync frame
 * larger than this raises the limit to twice its size, so the frames after it still fit.
 */
export const PENDING_BYTES = 1024 * 1024;

const HEARTBEAT = ": keep-alive\n\n";
const FRAMES_PER_CHUNK = 100;
const encoder = new TextEncoder();

/** What the shell reads from a stream's options: its queue limits, its signal, and what it does when it ends. */
export interface SseStreamOptions {
  readonly pendingLimit?: number;
  readonly pendingBytes?: number;
  readonly signal?: AbortSignal;
  readonly onEnd?: () => void;
  readonly heartbeatMs?: number;
}

/** The shell of one stream, as the stream's own parts see it. */
export interface SseShell {
  readonly frames: FrameBuffer;
  /** True once the stream has stopped, whatever stopped it. */
  readonly done: boolean;
  /** Wakes the read that waits for a frame, if one waits. */
  notify(): void;
  /** Registers a function to run when the stream stops, for a subscription taken after `attach` returned. */
  onStop(release: () => void): void;
  /** Ends the stream once: runs the releases, clears the heartbeat, runs `onEnd`, and wakes the read. */
  stop(): void;
}

/**
 * What a stream brings of its own. The shell runs `attach`, then queues the retry hint, then runs `begin`, so the frames
 * that start a client always follow the hint whatever the stream replays.
 */
export interface SseParts {
  /** Subscribes to what the stream reads, and returns the function that releases the subscription. */
  attach(): () => void;
  /** Queues the frames that start a client: the replay, the sync, or both. */
  begin(): void;
  /** True while a read that finds the queue empty should wait for frames. Absent means it always waits. */
  holds?(): boolean;
  /** Runs when a read finds the queue empty and the stream has not stopped. True stops the stream and closes it. */
  drained?(): boolean;
}

/**
 * The body every server-sent-event stream in the app shares. It holds one bounded queue of frames and one read loop:
 * a read waits for a frame, takes up to FRAMES_PER_CHUNK of them as one chunk, and closes once the stream stopped. The
 * stream that calls it says only how it starts (its subscription, its replay, its sync), when a read should wait, and
 * when a drained queue should end it. A heartbeat keeps proxies from closing an idle stream, and the stream follows its
 * signal, stopping once whether the signal aborted or the reader cancelled.
 */
export function sseStream(options: SseStreamOptions, parts: (shell: SseShell) => SseParts): ReadableStream<Uint8Array> {
  const { signal } = options;
  const frames = new FrameBuffer({
    frames: options.pendingLimit ?? PENDING_LIMIT,
    bytes: options.pendingBytes ?? PENDING_BYTES,
  });
  const releases: (() => void)[] = [];
  let done = false;
  let cancelled = false;
  let wake: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const stop = () => {
    if (done) return;
    done = true;
    for (const release of releases.splice(0)) release();
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", stop);
    options.onEnd?.();
    notify();
  };

  const shell: SseShell = {
    frames,
    get done() {
      return done;
    },
    notify,
    onStop: (release) => {
      releases.push(release);
    },
    stop,
  };
  const stream = parts(shell);

  return new ReadableStream<Uint8Array>({
    start() {
      try {
        shell.onStop(stream.attach());
        frames.force(`retry: ${RETRY_MS}\n\n`);
        stream.begin();
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
        if (frames.length === 0 && !done && (stream.holds?.() ?? true)) {
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
        if (stream.drained?.()) {
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
