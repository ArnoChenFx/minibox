import { sseStream } from "../events/sse-body";
import type { LogEvent, LogFollows, LogSubscription } from "../host/log-follow";

export interface LogStreamOptions {
  /** The host's log follows. The stream subscribes to one box of them, so every stream of a box shares one follow. */
  readonly follows: LogFollows;
  readonly boxId: string;
  /** Lines the `sync` frames hold: the newest ones the feed has, at most this many. */
  readonly tail: number;
  readonly signal?: AbortSignal;
  /** Runs once when the stream ends: the signal aborted, the reader cancelled, the box was removed, or the host stopped. */
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
 * queue, which is cleared first. A `closed` frame ends the stream when the box is removed. When the host stops, the stream
 * ends without a frame, so the client reads the box again once it reconnects.
 */
export function logStream(options: LogStreamOptions): ReadableStream<Uint8Array> {
  const { follows, boxId, tail } = options;
  let subscription: LogSubscription | undefined;
  let ending = false;

  return sseStream(options, (shell) => {
    const { frames, notify } = shell;

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
      if (shell.done || ending) return;
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
      if (event.kind === "stopped") {
        ending = true;
        notify();
        return;
      }
      if (frames.push(frame("line", { text: event.line.text }))) notify();
      else resync();
    };

    return {
      attach: () => {
        subscription = follows.subscribe(boxId, onLog);
        return () => {
          subscription?.unsubscribe();
          subscription = undefined;
        };
      },
      begin: () => frames.force(syncFrame()),
      // A `closed` frame is queued behind `ending`: a read waits for the queue to drain, and the queue ends the stream.
      holds: () => !ending,
      drained: () => ending,
    };
  });
}
