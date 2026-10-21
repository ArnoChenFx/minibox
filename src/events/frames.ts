/** How much a stream may hold for a client that has not read it yet. */
export interface FrameLimits {
  /** Frames queued, a keyed frame counted once. */
  frames: number;
  /** UTF-8 bytes of the frames queued. */
  bytes: number;
}

interface Entry {
  text: string;
  bytes: number;
  readonly key: string | undefined;
}

/**
 * The frames queued for one client, in the order they will be sent. A keyed frame replaces the one queued under the same
 * key, in its place. A client that reads slowly is therefore sent the latest state of each keyed frame, not each state
 * in turn.
 */
export class FrameBuffer {
  private readonly entries: Entry[] = [];
  private readonly keyed = new Map<string, Entry>();
  private readonly frameLimit: number;
  private byteLimit: number;
  private held = 0;

  constructor(limits: FrameLimits) {
    this.frameLimit = limits.frames;
    this.byteLimit = limits.bytes;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Queues a frame if the buffer stays within its limits. Returns false, and queues nothing, when it would not. */
  push(text: string, key?: string): boolean {
    const bytes = Buffer.byteLength(text);
    const previous = key === undefined ? undefined : this.keyed.get(key);
    const frames = previous ? this.entries.length : this.entries.length + 1;
    const total = this.held - (previous?.bytes ?? 0) + bytes;
    if (frames > this.frameLimit || total > this.byteLimit) return false;
    this.store({ text, bytes, key }, previous);
    return true;
  }

  /**
   * Raises the byte limit to `bytes` if that is higher, and never lowers it. A frame that must be sent whole, such as a
   * sync, can be larger than the limit; raising the limit past it lets the frames queued behind it fit.
   */
  raiseByteLimit(bytes: number): void {
    this.byteLimit = Math.max(this.byteLimit, bytes);
  }

  /** Queues a frame whatever the limits. For the frames a stream must send in full: retry, sync, reset and replay. */
  force(text: string): void {
    this.store({ text, bytes: Buffer.byteLength(text), key: undefined }, undefined);
  }

  /** Removes up to `count` frames from the front, and returns their text in order. */
  take(count: number): string[] {
    const taken = this.entries.splice(0, count);
    for (const entry of taken) {
      this.held -= entry.bytes;
      if (entry.key !== undefined && this.keyed.get(entry.key) === entry) this.keyed.delete(entry.key);
    }
    return taken.map((entry) => entry.text);
  }

  clear(): void {
    this.entries.length = 0;
    this.keyed.clear();
    this.held = 0;
  }

  private store(entry: Entry, previous: Entry | undefined): void {
    if (previous) {
      this.held += entry.bytes - previous.bytes;
      previous.text = entry.text;
      previous.bytes = entry.bytes;
      return;
    }
    this.entries.push(entry);
    this.held += entry.bytes;
    if (entry.key !== undefined) this.keyed.set(entry.key, entry);
  }
}
