import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * The event, task and box log streams open at once, counted across the app. A stream past `max` is refused with 429
 * rather than queued, so a crowd of tabs or a runaway client cannot hold every socket and every bus subscription.
 */
export class StreamSlots {
  private open = 0;

  constructor(readonly max: number) {}

  get count(): number {
    return this.open;
  }

  /** Takes a slot for a stream, or throws 429 when all are taken. The function it returns gives the slot back, once. */
  acquire(): () => void {
    if (this.open >= this.max) {
      throw new AppError(429, "too_many_requests", msg("stream_limit", { max: this.max }));
    }
    this.open += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.open -= 1;
    };
  }
}
