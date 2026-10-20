/** In-memory ring buffer of recent user operations, shown on the overview page. */
export interface ActivityEntry {
  t: string;
  action: string;
  target: string;
  ok: boolean;
  message?: string;
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  constructor(private readonly max = 50) {}

  add(entry: Omit<ActivityEntry, "t">): void {
    this.entries.unshift({ t: new Date().toISOString(), ...entry });
    if (this.entries.length > this.max) this.entries.length = this.max;
  }

  list(limit = 20): ActivityEntry[] {
    return this.entries.slice(0, limit);
  }
}
