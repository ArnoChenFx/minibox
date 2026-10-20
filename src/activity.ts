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

/** Run an operation and record it in the activity log (success or failure). */
export async function tracked<T>(
  activity: ActivityLog,
  action: string,
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    activity.add({ action, target, ok: true });
    return result;
  } catch (e) {
    activity.add({ action, target, ok: false, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
