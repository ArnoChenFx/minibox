export declare const KINDS: readonly ["manual", "automatic", "pinned", "legacy"];
export declare const HOLD_MODES: readonly ["live", "pause", "stop"];
export declare const REASON_KEYS: readonly [
  "ck.reasonLegacy",
  "ck.reasonPending",
  "ck.reasonNoData",
  "ck.reasonHeld",
  "ck.reasonPinned",
];

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
  rollback: RuleResult;
  pin: RuleResult;
  delete: RuleResult;
}

export interface RowState {
  held?: boolean;
  pending?: boolean;
}

export interface Usage {
  bytes: number;
  limitBytes: number | null;
}

export declare function kindsOf(checkpoint: CheckpointRow): string[];
export declare function contentsOf(checkpoint: CheckpointRow): { roles: string[]; others: number; system: boolean };
export declare function rowActions(checkpoint: CheckpointRow, state?: RowState): RowActions;
export declare function newestFirst<T extends { createdAt: string }>(checkpoints: readonly T[]): T[];
export declare function usedPercent(usage: Usage): number | null;
