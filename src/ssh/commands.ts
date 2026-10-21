/** Counts the commands an SSH client runs in each box. Idle sleep reads it: a command with no input is still work. */
export class CommandTracker {
  private readonly counts = new Map<string, number>();

  begin(boxId: string): () => void {
    this.counts.set(boxId, (this.counts.get(boxId) ?? 0) + 1);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      const left = (this.counts.get(boxId) ?? 1) - 1;
      if (left > 0) this.counts.set(boxId, left);
      else this.counts.delete(boxId);
    };
  }

  active(boxId: string): boolean {
    return (this.counts.get(boxId) ?? 0) > 0;
  }
}
