import type { Readable } from "node:stream";

import { RuntimeError } from "../runtime";
import { toRuntimeError } from "./errors";

const FRAME_HEADER_BYTES = 8;
const NEWLINE = 0x0a;
/** A line that grows past this without a newline is yielded in pieces, so one line cannot grow without bound. */
const MAX_LINE_BYTES = 64 * 1024;
const EMPTY = Buffer.alloc(0);

/**
 * A container without a TTY multiplexes stdout and stderr into frames: a header of the stream kind, three zero bytes
 * and the payload size, then the payload. A TTY stream is raw text.
 */
function isFramed(buf: Buffer): boolean {
  const first = buf[0];
  return (
    buf.length >= FRAME_HEADER_BYTES &&
    first !== undefined &&
    first <= 2 &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0
  );
}

/** Strip Docker's 8-byte multiplexing headers from a non-TTY log stream. */
export function demuxLogs(buf: Buffer): string {
  if (!isFramed(buf)) return buf.toString("utf8");
  const payloads: Buffer[] = [];
  let i = 0;
  while (i + FRAME_HEADER_BYTES <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    i += FRAME_HEADER_BYTES;
    payloads.push(buf.subarray(i, i + size));
    i += size;
  }
  return Buffer.concat(payloads).toString("utf8");
}

/**
 * The first cut at or before `at` that does not split a UTF-8 character. A run of continuation bytes that is not a
 * character returns `at` itself, so the cut always moves forward.
 */
function charBoundary(bytes: Buffer, at: number): number {
  for (let cut = at; cut > at - 4; cut -= 1) {
    if (((bytes[cut] ?? 0) & 0xc0) !== 0x80) return cut;
  }
  return at;
}

/**
 * Splits a log stream into lines as its bytes arrive, reading it as frames or as raw text by the test `demuxLogs`
 * applies to the whole stream. A line ends at a newline, and a carriage return before it is dropped. Bytes are only
 * decoded once a line is complete, so a character split across chunks is decoded whole.
 */
export class LogLines {
  private mode: "unknown" | "framed" | "raw" = "unknown";
  /** Bytes not yet read: a partial frame, or the bytes that decide the framing. */
  private pending: Buffer = EMPTY;
  private line: Buffer = EMPTY;

  /** The lines that `chunk` completes, in order. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.mode === "unknown") {
      if (this.pending.length < FRAME_HEADER_BYTES) return lines;
      this.mode = isFramed(this.pending) ? "framed" : "raw";
    }
    if (this.mode === "raw") {
      this.split(this.pending, lines);
      this.pending = EMPTY;
      return lines;
    }
    let at = 0;
    while (this.pending.length - at >= FRAME_HEADER_BYTES) {
      const end = at + FRAME_HEADER_BYTES + this.pending.readUInt32BE(at + 4);
      if (end > this.pending.length) break;
      this.split(this.pending.subarray(at + FRAME_HEADER_BYTES, end), lines);
      at = end;
    }
    this.pending = this.pending.subarray(at);
    return lines;
  }

  /** The lines still held when the stream ends: a truncated frame's payload, and a line without its newline. */
  end(): string[] {
    const lines: string[] = [];
    if (this.mode === "framed") {
      let at = 0;
      while (this.pending.length - at >= FRAME_HEADER_BYTES) {
        const end = at + FRAME_HEADER_BYTES + this.pending.readUInt32BE(at + 4);
        this.split(this.pending.subarray(at + FRAME_HEADER_BYTES, Math.min(end, this.pending.length)), lines);
        at = end;
      }
    } else {
      this.split(this.pending, lines);
    }
    if (this.line.length > 0) lines.push(this.line.toString("utf8"));
    this.line = EMPTY;
    this.pending = EMPTY;
    return lines;
  }

  private split(bytes: Buffer, lines: string[]): void {
    let from = 0;
    for (let newline = bytes.indexOf(NEWLINE); newline !== -1; newline = bytes.indexOf(NEWLINE, from)) {
      lines.push(this.finishLine(bytes.subarray(from, newline)));
      from = newline + 1;
    }
    this.line = Buffer.concat([this.line, bytes.subarray(from)]);
    while (this.line.length > MAX_LINE_BYTES) {
      const cut = charBoundary(this.line, MAX_LINE_BYTES);
      lines.push(this.line.subarray(0, cut).toString("utf8"));
      this.line = this.line.subarray(cut);
    }
  }

  /** The line in progress, followed by `bytes` and its newline. */
  private finishLine(bytes: Buffer): string {
    const text = Buffer.concat([this.line, bytes]).toString("utf8");
    this.line = EMPTY;
    return text.endsWith("\r") ? text.slice(0, -1) : text;
  }
}

/**
 * A failure of a followed log, whether the request or the stream failed. A connection that breaks is `unavailable`,
 * including a reset that toRuntimeError does not classify.
 */
export function followFailure(e: unknown): RuntimeError {
  if (e instanceof RuntimeError) return e;
  const mapped = toRuntimeError(e);
  if (mapped instanceof RuntimeError) return mapped;
  return new RuntimeError("unavailable", e instanceof Error ? e.message : String(e));
}

/**
 * The lines of a followed log stream until it ends. The engine keeps a followed response open until the client closes
 * it, so destroying the stream is what ends the request on abort. An abort ends the iterator without an error; any
 * other failure of the stream is reported as a RuntimeError.
 */
export async function* followedLines(stream: Readable, signal?: AbortSignal): AsyncGenerator<string> {
  const stop = () => stream.destroy();
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  const lines = new LogLines();
  try {
    for await (const chunk of stream) {
      for (const line of lines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        if (signal?.aborted) return;
        yield line;
      }
    }
    for (const line of lines.end()) {
      if (signal?.aborted) return;
      yield line;
    }
  } catch (e) {
    if (signal?.aborted) return;
    throw followFailure(e);
  } finally {
    signal?.removeEventListener("abort", stop);
    stream.destroy();
  }
}
