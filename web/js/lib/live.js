/**
 * The live connection to `/api/events/stream`. One EventSource serves the whole page and opens with the first
 * subscriber. The browser reconnects a dropped connection by itself. An EventSource that the browser gives up on is
 * reopened here, after a delay that grows. Pages poll only while the connection is down (`pollWhileDown`).
 *
 * Frames arrive by kind: `sync` (the state a client starts from), `box`, `sample`, `link`, `host`, `task`, and `reset`
 * when the stream could not send every stored event. Stored events arrive as `event`.
 */

const STREAM_URL = "/api/events/stream";
const KINDS = ["sync", "box", "sample", "link", "host", "task", "reset"];
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

const handlers = new Map();
const stateHandlers = new Set();
let source = null;
let connected = false;
let failures = 0;

/** The wait before the next reopen, after `failed` failed attempts: 1s, 2s, 4s and so on, up to 30s. */
export function retryDelay(failed) {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** failed);
}

export const isLive = () => connected;

function setConnected(value) {
  if (connected === value) return;
  connected = value;
  for (const fn of stateHandlers) fn(connected);
}

function deliver(kind, message) {
  let data;
  try {
    data = JSON.parse(message.data);
  } catch {
    return;
  }
  for (const fn of handlers.get(kind) ?? []) fn(data);
}

function connect() {
  if (source || typeof EventSource === "undefined") return;
  const next = new EventSource(STREAM_URL);
  source = next;
  next.addEventListener("open", () => {
    failures = 0;
    setConnected(true);
  });
  next.addEventListener("error", () => {
    setConnected(false);
    if (next.readyState !== EventSource.CLOSED) return;
    next.close();
    source = null;
    const delay = retryDelay(failures);
    failures += 1;
    setTimeout(connect, delay);
  });
  for (const kind of KINDS) next.addEventListener(kind, (message) => deliver(kind, message));
  next.addEventListener("message", (message) => deliver("event", message));
}

/** Calls `fn` with each frame of `kind`. The first subscription opens the connection. Returns the unsubscribe. */
export function subscribe(kind, fn) {
  let set = handlers.get(kind);
  if (!set) {
    set = new Set();
    handlers.set(kind, set);
  }
  set.add(fn);
  connect();
  return () => {
    set.delete(fn);
  };
}

/** Calls `fn` now with the connection state, and again each time it changes. Returns the unsubscribe. */
export function onLiveState(fn) {
  stateHandlers.add(fn);
  connect();
  fn(connected);
  return () => {
    stateHandlers.delete(fn);
  };
}

/**
 * Runs `refresh` every `everyMs` while the connection is down, and stops while it is up. The frames keep the page
 * current in the meantime. Returns the function that stops it.
 */
export function pollWhileDown(refresh, everyMs) {
  let timer = null;
  const off = onLiveState((live) => {
    if (live) {
      clearInterval(timer);
      timer = null;
    } else if (!timer) {
      timer = setInterval(refresh, everyMs);
    }
  });
  return () => {
    off();
    clearInterval(timer);
    timer = null;
  };
}
