/** How much of each stream a foreground or polled result keeps from each end. */
export const EXEC_INLINE_EDGE_BYTES = 16 * 1024;

/**
 * A byte buffer that keeps the whole stream until it passes two edges, then only the first and last edge.
 * Appended chunks are copied, so a later consumer of the original chunk can be released.
 */
export class EdgeBuffer {
  private split = false;
  private headBuf: Buffer = Buffer.alloc(0);
  private tailBuf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private held = 0;
  private total = 0;

  constructor(private readonly edge: number) {}

  get byteLength(): number {
    return this.total;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.total += chunk.byteLength;
    if (this.split) {
      this.tailBuf = copySuffix([this.tailBuf], this.tailBuf.length, chunk, this.edge);
      return;
    }
    if (this.held + chunk.byteLength <= this.edge * 2) {
      this.parts.push(Buffer.from(chunk));
      this.held += chunk.byteLength;
      return;
    }
    this.headBuf = copyPrefix(this.parts, chunk, this.edge);
    this.tailBuf = copySuffix(this.parts, this.held, chunk, this.edge);
    this.parts = [];
    this.held = 0;
    this.split = true;
  }

  /** The text a caller sees for a window of `edge` bytes at each end. Shorter streams are returned whole. */
  project(edge = this.edge): { text: string; truncated: boolean; bytes: number } {
    if (!this.split) {
      const all = this.parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.parts, this.held);
      if (all.length <= edge * 2) return { text: all.toString("utf8"), truncated: false, bytes: this.total };
      return noted(all.subarray(0, edge), all.subarray(all.length - edge), this.total);
    }
    const head = this.headBuf.subarray(0, Math.min(edge, this.headBuf.length));
    const tail = this.tailBuf.subarray(Math.max(0, this.tailBuf.length - edge));
    return noted(head, tail, this.total);
  }
}

function noted(head: Buffer, tail: Buffer, total: number): { text: string; truncated: boolean; bytes: number } {
  const omitted = total - head.length - tail.length;
  if (omitted <= 0) return { text: Buffer.concat([head, tail]).toString("utf8"), truncated: false, bytes: total };
  return {
    text: `${head.toString("utf8")}\n… ${omitted} bytes omitted …\n${tail.toString("utf8")}`,
    truncated: true,
    bytes: total,
  };
}

function copyPrefix(parts: readonly Buffer[], chunk: Uint8Array, count: number): Buffer {
  const out = Buffer.alloc(count);
  let filled = 0;
  for (const part of parts) {
    if (filled >= count) break;
    const n = Math.min(part.length, count - filled);
    part.copy(out, filled, 0, n);
    filled += n;
  }
  if (filled < count && chunk.byteLength > 0) {
    const n = Math.min(chunk.byteLength, count - filled);
    out.set(chunk.subarray(0, n), filled);
    filled += n;
  }
  return filled === count ? out : out.subarray(0, filled);
}

function copySuffix(parts: readonly Buffer[], held: number, chunk: Uint8Array, count: number): Buffer {
  if (chunk.byteLength >= count) return Buffer.from(chunk.subarray(chunk.byteLength - count));
  const need = count - chunk.byteLength;
  const prior = held === 0 ? Buffer.alloc(0) : Buffer.concat(parts, held);
  const fromPrior = prior.subarray(Math.max(0, prior.length - need));
  if (chunk.byteLength === 0) return Buffer.from(fromPrior);
  return Buffer.concat([fromPrior, Buffer.from(chunk)]);
}
