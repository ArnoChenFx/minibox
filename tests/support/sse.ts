/** One server-sent event as a client reads it. Only the fields the stream uses are set. */
export interface SseFrame {
  id?: number;
  event?: string;
  data?: unknown;
  retry?: number;
  comment?: string;
}

export function parseFrame(block: string): SseFrame {
  const frame: SseFrame = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
    else if (line.startsWith("retry: ")) frame.retry = Number(line.slice(7));
  }
  return frame;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no data for ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The part of a stream reader that the tests use. Both the global and the Node reader types satisfy it. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/**
 * Reads frames from an event stream. Chunks may split a frame or join several, so the text is buffered and cut at blank
 * lines, and frames that arrive together are kept for the next call.
 */
export class SseReader {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly pending: SseFrame[] = [];

  constructor(private readonly reader: ChunkReader) {}

  /** Reads one chunk and queues the frames it completes. False once the server has ended the stream. */
  private async fill(timeoutMs: number): Promise<boolean> {
    const { value, done } = await within(this.reader.read(), timeoutMs);
    if (done) return false;
    this.buffer += this.decoder.decode(value, { stream: true });
    for (let end = this.buffer.indexOf("\n\n"); end !== -1; end = this.buffer.indexOf("\n\n")) {
      this.pending.push(parseFrame(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end + 2);
    }
    return true;
  }

  async next(timeoutMs = 5000): Promise<SseFrame> {
    while (this.pending.length === 0) {
      if (!(await this.fill(timeoutMs))) throw new Error("the stream closed before the next event");
    }
    const frame = this.pending.shift();
    if (!frame) throw new Error("no frame");
    return frame;
  }

  /** Reads frames until one satisfies `match`, and returns that frame. */
  async until(match: (frame: SseFrame) => boolean, timeoutMs = 5000): Promise<SseFrame> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (match(frame)) return frame;
    }
  }

  /** Reads and discards whatever arrives until the server ends the stream. Fails if it stays open for `timeoutMs`. */
  async untilEnd(timeoutMs = 5000): Promise<void> {
    for (;;) {
      const { done } = await within(this.reader.read(), timeoutMs);
      if (done) return;
    }
  }

  /** Reads until the server ends the stream, and returns every frame that was not read yet, in order. */
  async framesUntilEnd(timeoutMs = 5000): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    while (await this.fill(timeoutMs)) frames.push(...this.pending.splice(0));
    frames.push(...this.pending.splice(0));
    return frames;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

/** The id of a frame, which is the sequence number of its event. Throws for a frame that has none. */
export function idOf(frame: SseFrame): number {
  if (frame.id === undefined) throw new Error("the frame has no id");
  return frame.id;
}

/** The operation name of an event frame, or `undefined` for a frame that is not an event. */
export function opOf(frame: SseFrame): string | undefined {
  return (frame.data as { op?: string } | undefined)?.op;
}

/** The summary of an event frame, or `undefined` for a frame that is not an event. */
export function summaryOf(frame: SseFrame): string | undefined {
  return (frame.data as { summary?: string } | undefined)?.summary;
}
