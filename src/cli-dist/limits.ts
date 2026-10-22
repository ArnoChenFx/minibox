/** Runs at most `limit` tasks at once. A task that finishes hands its slot straight to the next waiter. */
export class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** A fixed window per key. Requests past `max` in one window are refused until the window ends. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private static readonly SWEEP_AT = 10_000;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request. Returns 0 when it may proceed, or the seconds until the window ends when it may not. */
  take(key: string): number {
    const now = this.now();
    if (this.windows.size >= FixedWindowLimiter.SWEEP_AT) this.sweep(now);
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.max) return 0;
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
