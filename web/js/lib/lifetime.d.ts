/** A unit a lifetime is entered in, with the seconds it holds. `id` ends a dictionary key. */
export interface LifetimeUnit {
  id: "days" | "hours" | "minutes" | "seconds";
  seconds: number;
}

/** The number and unit a form holds for one lifetime. */
export interface LifetimeDraft {
  value: number;
  unit: LifetimeUnit["id"];
}

/** The idle timeout's mode: `null` inherits the global default, `0` never sleeps, a positive number is the box's own. */
export type IdleMode = "inherit" | "never" | "custom";

/** The TTL's mode: `null` means no TTL, a positive number is a lifetime counted from the box's creation. */
export type TtlMode = "none" | "set";

/** What a lifecycle form holds, as the card reads it back from the fields. */
export interface LifetimeForm {
  idleMode: IdleMode;
  idleValue: string;
  idleUnit: LifetimeUnit["id"];
  ttlMode: TtlMode;
  ttlValue: string;
  ttlUnit: LifetimeUnit["id"];
}

/** The in-place lifecycle fields of a box, as the API returns them. */
export interface LifetimeBox {
  idleTimeoutSec?: number | null;
  ttlSec?: number | null;
}

export declare const MAX_LIFETIME_SEC: number;
export declare const LIFETIME_UNITS: readonly LifetimeUnit[];

export declare function lifetimeSeconds(value: string, unitId: LifetimeUnit["id"]): number | null;
export declare function lifetimeDraft(seconds?: number | null, fallback?: number): LifetimeDraft;
export declare function idleModeOf(seconds?: number | null): IdleMode;
export declare function ttlModeOf(seconds?: number | null): TtlMode;
export declare function lifetimePatch(
  box: LifetimeBox,
  form: LifetimeForm,
): { patch: { idleTimeoutSec?: number | null; ttlSec?: number | null } } | { problem: "idle" | "ttl" };
