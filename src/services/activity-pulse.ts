/**
 * In-memory last-activity heartbeats per box. Used for idle sleep (#12); not persisted and not the events table.
 */
export type ActivityKind = "terminal" | "exec" | "session" | "file" | "preview" | "create" | "wake";

export class ActivityPulse {
  private readonly last = new Map<string, number>();

  touch(boxId: string, _kind?: ActivityKind, at = Date.now()): void {
    this.last.set(boxId, at);
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
