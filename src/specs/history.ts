import type { BoxSpec, SpecSnapshot } from "./types";

/** Recent revisions kept on the spec so a failed rebuild can restore the previous one. */
const SPEC_HISTORY_LIMIT = 20;

/** The spec as of this revision, without the history list it was stored beside. */
function snapshotOf(spec: BoxSpec): SpecSnapshot {
  const { history: _history, ...rest } = spec;
  return { revision: spec.revision, at: spec.updatedAt, spec: rest };
}

/** Newest first, capped. The snapshot is the spec before the write that calls this. */
export function pushHistory(spec: BoxSpec): SpecSnapshot[] {
  return [snapshotOf(spec), ...(spec.history ?? [])].slice(0, SPEC_HISTORY_LIMIT);
}
