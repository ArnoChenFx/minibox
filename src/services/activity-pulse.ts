/**
 * In-memory last-activity heartbeats per box. Used for idle sleep (#12); not persisted and not the events table.
 */
export type ActivityKind = "terminal" | "exec" | "session" | "file" | "preview" | "create" | "wake" | "task";

export class ActivityPulse {
  private readonly last = new Map<string, number>();
  private readonly holds = new Map<string, number>();

  touch(boxId: string, _kind?: ActivityKind, at = Date.now()): void {
    this.last.set(boxId, at);
  }

  /**
   * Keeps a box from idle sleep until the returned release is called. Use it for work that outlives the idle window,
   * such as a preview response still streaming. Release counts as activity, so the idle clock starts from there.
   */
  hold(boxId: string): () => void {
    this.holds.set(boxId, (this.holds.get(boxId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(boxId) ?? 1) - 1;
      if (left > 0) this.holds.set(boxId, left);
      else this.holds.delete(boxId);
      this.touch(boxId);
    };
  }

  isHeld(boxId: string): boolean {
    return (this.holds.get(boxId) ?? 0) > 0;
  }

  /** Epoch ms of the last touch, or `null` when nothing has been recorded since process start. */
  lastAt(boxId: string): number | null {
    return this.last.get(boxId) ?? null;
  }

  /** ISO timestamp for API views, or `null` when unknown. */
  lastActivityAt(boxId: string): string | null {
    const at = this.lastAt(boxId);
    return at === null ? null : new Date(at).toISOString();
  }

  clear(boxId: string): void {
    this.last.delete(boxId);
  }
}
