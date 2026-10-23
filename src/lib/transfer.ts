/** What a transfer reports while it runs: a signal that stops it, and lines for the task log. A task handle satisfies it. */
export interface TransferProgress {
  readonly signal?: AbortSignal;
  log?(text: string): void;
}

/** Called with the bytes moved so far. Each call is cheap, so a transfer reports every chunk without holding a copy. */
export type ByteProgress = (bytes: number) => void;

const LOG_STEP_BYTES = 16 * 1024 * 1024;

/** Passes `source` through unchanged, and reports the running byte total after each chunk. */
export async function* countingChunks(
  source: AsyncIterable<Uint8Array>,
  onBytes: ByteProgress,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    onBytes(total);
    yield chunk;
  }
}

/**
 * A byte callback that writes `verb` and the megabytes moved to the task log each time another 16 MB has passed, so a
 * long transfer shows that it moves without a line per chunk. Null when there is no task to log to.
 */
export function byteLog(progress: TransferProgress | undefined, verb: string): ByteProgress | undefined {
  if (!progress?.log) return undefined;
  let next = LOG_STEP_BYTES;
  return (bytes) => {
    if (bytes < next) return;
    next = (Math.floor(bytes / LOG_STEP_BYTES) + 1) * LOG_STEP_BYTES;
    progress.log?.(`${verb} ${Math.floor(bytes / (1024 * 1024))} MB…\n`);
  };
}
