export declare const KINDS: readonly ["manual", "automatic", "pinned", "legacy"];
export declare const HOLD_MODES: readonly ["live", "pause", "stop"];
export declare const REASON_KEYS: readonly [
  "ck.reasonLegacy",
  "ck.reasonPending",
  "ck.reasonNoData",
  "ck.reasonEmpty",
  "ck.reasonHeld",
  "ck.reasonPinned",
  "ck.reasonSystem",
];
export declare const SKIP_REASON_KEYS: Readonly<Record<string, string>>;
export declare const PASSPHRASE_MIN: number;
export declare const PASSPHRASE_MAX: number;
export declare const SCHEDULE_HOURS: Readonly<{ min: number; max: number }>;

export interface CheckpointLayer {
  role: string | null;
  ownership: string;
}

export interface CheckpointRow {
  legacy: boolean;
  auto: boolean;
  pinned: boolean;
  createdAt: string;
  system: unknown;
  data: readonly CheckpointLayer[];
}

export interface RuleResult {
  allowed: boolean;
  reason: string;
}

export interface RowActions {
  fork: RuleResult;
  export: RuleResult;
  rollback: RuleResult;
  pin: RuleResult;
  delete: RuleResult;
}

export interface RowState {
  held?: boolean;
  pending?: boolean;
  elsewhere?: boolean;
}

export interface Usage {
  bytes: number;
  limitBytes: number | null;
}

export declare function kindsOf(checkpoint: CheckpointRow): string[];
export declare function contentsOf(checkpoint: CheckpointRow): { roles: string[]; others: number; system: boolean };
export declare function rowActions(checkpoint: CheckpointRow, state?: RowState): RowActions;
export declare function passphraseOk(value: string): boolean;
export declare function scheduleZone(
  schedule: { timezone?: string | null; timezoneUnknown?: boolean } | null | undefined,
): string;
export declare function browserTimezone(): string;
export declare function scheduleBody(
  mode: "interval" | "daily",
  input: { hours?: string | number; at?: string; timezone?: string },
): { everyHours: number } | { at: string; timezone: string } | null;
export declare function newestFirst<T extends { createdAt: string }>(checkpoints: readonly T[]): T[];
export declare function usedPercent(usage: Usage): number | null;
