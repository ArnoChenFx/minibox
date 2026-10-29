export interface ScheduleLike {
  mode: "interval" | "daily";
  everyHours: number | null;
  at: string | null;
  timezone?: string | null;
  timezoneUnknown?: boolean;
  nextRunAt: string;
  lastRun: {
    at: string;
    status: string;
    error?: string | null;
    errorKey?: string | null;
    errorParams?: Record<string, string | number> | null;
  } | null;
}

/** The words a card uses for its own work, so a checkpoint card and a backup card share the markup. */
export interface ScheduleLabels {
  title: string;
  offHelp: string;
  note: string;
  ok: string;
  failed: string;
  none: string;
}

export interface ScheduleFieldIds {
  hours: string;
  at: string;
  error: string;
}

export declare function zonedTime(iso: string, zone: string): string;
export declare function ruleText(schedule: ScheduleLike): string;
export declare function lastRunText(
  run: ScheduleLike["lastRun"],
  zone: string,
  labels: Pick<ScheduleLabels, "ok" | "failed" | "none">,
): string;
export declare function scheduleCardHtml(
  schedule: ScheduleLike | null | undefined,
  options: {
    zone?: string;
    labels: ScheduleLabels;
    action: string;
    /** Overrides the last-run line, for a schedule whose skipped runs say why. */
    lastRun?: typeof lastRunText;
  },
): string;
export declare function scheduleFieldsHtml(
  schedule: ScheduleLike | null | undefined,
  options: { zone?: string; ids: ScheduleFieldIds; help: string },
): string;
export declare function bindScheduleForm(
  root: Element,
  options: { ids: ScheduleFieldIds; invalid: string; onRule: (body: unknown) => void },
): () => unknown;
