type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = "info";

/**
 * Where a line goes, and the level under which a line is dropped. The default writes to the console under the global
 * `threshold`. A test that needs the lines installs a sink with its own floor, so its collection does not race the log
 * level or the console mocks that other concurrently running test files hold.
 */
let sink: ((level: Level, line: string) => void) | null = null;
let sinkFloor: Level = "debug";

export function setLogLevel(level: Level): void {
  threshold = level;
}

/** Routes every later log line at or above `minLevel` to `write` instead of the console. Returns the reset. */
export function setLogSink(write: (level: Level, line: string) => void, minLevel: Level = "debug"): () => void {
  const previous = sink;
  const previousFloor = sinkFloor;
  sink = write;
  sinkFloor = minLevel;
  return () => {
    sink = previous;
    sinkFloor = previousFloor;
  };
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[sink ? sinkFloor : threshold]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (sink) sink(level, line);
  else if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/** Minimal structured (JSON lines) logger. */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
