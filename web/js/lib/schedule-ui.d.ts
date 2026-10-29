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
    reason?: string | null;
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
  /** How a skipped run reads, with `{ time, reason }`. A schedule whose runs cannot be skipped leaves it out. */
  skipped?: string;
  /** The dictionary prefix of each reason code a skipped run names, such as `st.backupSkip.` for `busy`. */
  skipPrefix?: string;
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
  labels: Pick<ScheduleLabels, "ok" | "failed" | "none" | "skipped" | "skipPrefix">,
): string;
export declare function scheduleCardHtml(
  schedule: ScheduleLike | null | undefined,
  options: {
    zone?: string;
    labels: ScheduleLabels;
    action: string;
    /** Overrides the last-run line, for a schedule whose skipped runs say why. */
    lastRun?: typeof lastRunText;
    /** The dictionary key of why the schedule cannot be set or changed now. The card says it and disables those buttons. */
    blocked?: string | null;
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
