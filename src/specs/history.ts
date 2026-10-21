import type { BoxSpec, SpecSnapshot } from "./types";

/** Recent revisions kept on the spec so a failed rebuild can restore the previous one. */
export const SPEC_HISTORY_LIMIT = 20;

/** The spec as of this revision, without the history list it was stored beside. */
export function snapshotOf(spec: BoxSpec): SpecSnapshot {
  const { history: _history, ...rest } = spec;
  return { revision: spec.revision, at: spec.updatedAt, spec: rest };
}

/** Newest first, capped. The snapshot is the spec before the write that calls this. */
export function pushHistory(spec: BoxSpec): SpecSnapshot[] {
  return [snapshotOf(spec), ...(spec.history ?? [])].slice(0, SPEC_HISTORY_LIMIT);
}

/**
 * The revision immediately before `spec`, with the history that was current then.
 * Null when this spec has no stored history. A failed rebuild restores the in-memory
 * spec from before the write instead, which keeps a full history even at the cap.
 */
export function rollbackSpec(spec: BoxSpec): BoxSpec | null {
  const [previous, ...rest] = spec.history ?? [];
  if (!previous) return null;
  return { ...previous.spec, history: rest };
}
