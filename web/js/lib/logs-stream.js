/**
 * The live log of one box, from `GET /api/boxes/:id/logs/stream`. The first frame is `sync`, the newest lines the box has,
 * and each later line arrives as `line`. A `sync` comes again after every reconnect, so the view starts from the box's
 * current lines. `closed` means the box was removed and the stream is over.
 *
 * It uses an EventSource, as `live.js` does. The browser reconnects a dropped connection by itself, and one the browser
 * gives up on is reopened here after the delay `live.js` uses. `onState` reports the connection when it changes, so the
 * view can read the log itself while the stream is down.
 */
import { retryDelay } from "./live.js";

/** The newest `tail` lines, oldest first. Lines that fall behind `tail` are dropped as new ones arrive. */
export function lineWindow(tail) {
  let lines = [];
  return {
    replace(next) {
      lines = next.slice(-tail);
    },
    push(text) {
      lines.push(text);
      if (lines.length > tail) lines.splice(0, lines.length - tail);
    },
    lines() {
      return lines;
    },
  };
}

function frameOf(message) {
  try {
    return JSON.parse(message.data);
  } catch {
    return null;
  }
}

/**
 * Opens the log of a box and returns `{ close }`. `onSync(lines)` replaces what is shown, `onLine(text)` adds one line,
 * and `onClosed()` runs once when the box is removed. `onState(live)` runs when the connection goes up or down, and
 * first runs with `false` when the browser has no EventSource at all.
 */
export function openBoxLogs({ boxId, tail, onSync, onLine, onClosed, onState }) {
  if (typeof EventSource === "undefined") {
    onState?.(false);
    return { close() {} };
  }
  let source = null;
  let timer = null;
  let failures = 0;
  let live = null;

  const setLive = (value) => {
    if (live === value) return;
    live = value;
    onState?.(value);
  };

  const close = () => {
    clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };

  const connect = () => {
    timer = null;
    const next = new EventSource(`/api/boxes/${encodeURIComponent(boxId)}/logs/stream?tail=${tail}`);
    source = next;
    const on = (type, handle) => {
      next.addEventListener(type, (message) => {
        if (source === next) handle(message);
      });
    };
    on("open", () => {
      failures = 0;
      setLive(true);
    });
    on("sync", (message) => {
      const frame = frameOf(message);
      if (Array.isArray(frame?.lines)) onSync(frame.lines);
    });
    on("line", (message) => {
      const frame = frameOf(message);
      if (typeof frame?.text === "string") onLine(frame.text);
    });
    on("closed", () => {
      close();
      onClosed?.();
    });
    on("error", () => {
      setLive(false);
      if (next.readyState !== EventSource.CLOSED) return;
      next.close();
      source = null;
      const delay = retryDelay(failures);
      failures += 1;
      timer = setTimeout(connect, delay);
    });
  };

  connect();
  return { close };
}
