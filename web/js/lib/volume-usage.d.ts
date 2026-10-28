export interface VolumeLimitsView {
  softBytes: number | null;
  hardBytes: number | null;
  action: "warn" | "stop";
}

export interface UsagePointView {
  at: string;
  bytes: number;
}

export interface VolumeUsageView {
  bytes: number | null;
  bytesAt?: string | null;
  limits?: VolumeLimitsView;
  usage?: {
    scope: "volume" | "share";
    level: "unknown" | "ok" | "soft" | "hard";
    history: UsagePointView[];
    lastError: string | null;
  };
}

export interface UsageSummary {
  bytes: number | null;
  limit: { kind: "hard" | "soft"; bytes: number } | null;
  scale: number | null;
  level: "unknown" | "ok" | "soft" | "hard";
  history: UsagePointView[];
  shared: boolean;
}

export interface LimitForm {
  soft: string;
  hard: string;
  action: string;
}

export declare function usageSummary(volume: VolumeUsageView): UsageSummary;
export declare function fillPercent(bytes: number | null, scale: number | null): number | null;
export declare function levelClass(level: string): "crit" | "warn" | "";
export declare function levelLabelKey(level: string): "vol.overHard" | "vol.overSoft" | null;
export declare function bytesOfGb(
  text: string | null | undefined,
): { ok: true; bytes: number | null } | { ok: false; key: string };
export declare function limitsBody(
  form: LimitForm,
): { body: { softBytes: number | null; hardBytes: number | null; action: "warn" | "stop" } } | { error: string };
export declare function limitDraft(limits: VolumeLimitsView | null | undefined): LimitForm;
