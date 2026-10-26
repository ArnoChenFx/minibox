import type { HostCtx } from "../host/registry";
import { AppError, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { RebuildChange, RebuildPreview, RebuildRequest } from "../specs/plan";
import { type StagedField, type StagedFields, type StagedRecord, stagedFieldsOf } from "../specs/staged";
import type { BoxSpec } from "../specs/types";
import type { Box } from "./boxes";
import { planChange, type RebuildResult, rebuildBox, rebuildWithSafety } from "./rebuild";
import { preRebuildSafety, systemLayerAllowed } from "./safety";
import type { TerminalService } from "./terminals";
import type { RecordNote } from "./volume-owner";

/** Staged changes as the API returns them. `changes` is what applying would do, field by field. */
export interface StagedView {
  fields: StagedFields;
  /** The staged fields that still differ from the box. The banner counts these. */
  pending: StagedField[];
  changes: RebuildChange[];
  /** Why the staged changes cannot be applied as they stand, such as a secret that is no longer set. Null when they can. */
  problem: string | null;
  baseRevision: number;
  updatedAt: string;
  updatedBy: string;
}

/** What applying the staged changes would do, for the confirm dialog. */
export interface StagedPreview extends RebuildPreview {
  /** Terminal sessions that end with the old container. Null when they could not be read. */
  sessions: number | null;
  /** Whether a checkpoint taken first can include the writable layer. Not when the box's env names a secret. */
  systemCheckpoint: boolean;
  /** When the previewed staged changes were last changed. Apply takes it back to refuse changes staged since. */
  stagedAt: string;
}

/** A change field that comes from a staged field. The container rename comes with any change and is not staged. */
const STAGED_OF: Partial<Record<RebuildChange["field"], StagedField>> = {
  template: "template",
  mounts: "mounts",
  env: "env",
  network: "network",
  egress: "egress",
  profile: "profile",
};

const requestOf = (fields: StagedFields): RebuildRequest => ({ ...fields });

function specOf(host: HostCtx, box: Box): BoxSpec {
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  return spec;
}

const problemOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The staged fields that a rebuild would still change. A field that now matches the box, because it was changed back or
 * applied some other way, drops out. A moved tag or a rotated secret is a change of its own and does not keep a field.
 */
async function stillPending(
  host: HostCtx,
  spec: BoxSpec,
  fields: StagedFields,
  signal?: AbortSignal,
): Promise<StagedField[]> {
  const pending: StagedField[] = [];
  for (const field of stagedFieldsOf(fields)) {
    signal?.throwIfAborted();
    const planned = await planChange(host, spec, { [field]: fields[field] });
    signal?.throwIfAborted();
    if (planned.changes.some((change) => STAGED_OF[change.field] === field && !isSideChange(change, fields))) {
      pending.push(field);
    }
  }
  return pending;
}

/** A change a staged field did not ask for: the moved tag of a box whose staged template is its own ref. */
function isSideChange(change: RebuildChange, fields: StagedFields): boolean {
  return change.field === "template" && fields.template === undefined;
}

function pick(fields: StagedFields, keep: readonly StagedField[]): StagedFields {
  const out: StagedFields = {};
  for (const field of keep) Object.assign(out, { [field]: fields[field] });
  return out;
}

/**
 * The box's staged changes, or null when none are. Fields that no longer differ are dropped from the stored record, and a
 * record with none left is removed. A plan that fails leaves the record as it is and reports why.
 */
export async function readStaged(host: HostCtx, box: Box): Promise<StagedView | null> {
  return stagedOfSpec(host, specOf(host, box));
}

/**
 * The staged changes of one box spec, for a list that reads every box. The spec names the box, so a box that has been
 * deleted since it was listed is not read again here.
 */
export async function stagedOfSpec(host: HostCtx, spec: BoxSpec, signal?: AbortSignal): Promise<StagedView | null> {
  signal?.throwIfAborted();
  const record = host.specs.staged.read(spec.id);
  if (!record) return null;
  let pending: StagedField[];
  try {
    pending = await stillPending(host, spec, record.fields, signal);
  } catch (e) {
    signal?.throwIfAborted();
    return viewOf(record, stagedFieldsOf(record.fields), [], problemOf(e));
  }
  // A timed-out list may still have an engine call completing; it must not prune the stored record afterwards.
  signal?.throwIfAborted();
  if (pending.length === 0) {
    host.specs.staged.remove(spec.id);
    return null;
  }
  let current = record;
  if (pending.length !== stagedFieldsOf(record.fields).length) {
    current = { ...record, fields: pick(record.fields, pending) };
    host.specs.staged.write(current);
  }
  try {
    const planned = await planChange(host, spec, requestOf(current.fields));
    signal?.throwIfAborted();
    return viewOf(current, pending, planned.changes, null);
  } catch (e) {
    signal?.throwIfAborted();
    return viewOf(current, pending, [], problemOf(e));
  }
}

function viewOf(
  record: StagedRecord,
  pending: StagedField[],
  changes: RebuildChange[],
  problem: string | null,
): StagedView {
  return {
    fields: record.fields,
    pending,
    changes,
    problem,
    baseRevision: record.baseRevision,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

/**
 * Stages rebuild fields on top of what is already staged. A field passed again replaces the staged value. The box is not
 * touched. Changes that a rebuild would refuse, such as two mounts on one path, are refused here and nothing is staged.
 * Returns the staged changes as they now stand, or null when every field matches the box already.
 */
export async function stageChanges(
  host: HostCtx,
  box: Box,
  fields: StagedFields,
  principalId: string,
): Promise<StagedView | null> {
  const spec = specOf(host, box);
  const before = host.specs.staged.read(box.boxId);
  const merged: StagedFields = { ...before?.fields };
  for (const field of stagedFieldsOf(fields)) Object.assign(merged, { [field]: fields[field] });
  await planChange(host, spec, requestOf(merged));
  host.specs.staged.write({
    version: 1,
    boxId: box.boxId,
    fields: merged,
    baseRevision: spec.revision,
    updatedAt: new Date().toISOString(),
    updatedBy: principalId,
  });
  return readStaged(host, box);
}

/** Drops the box's staged changes. Returns whether there were any. */
export function discardStaged(host: HostCtx, box: Box): boolean {
  const had = host.specs.staged.read(box.boxId) !== null;
  host.specs.staged.remove(box.boxId);
  return had;
}

function requireStaged(host: HostCtx, box: Box): StagedRecord {
  const record = host.specs.staged.read(box.boxId);
  if (!record) throw new AppError(404, "not_found", msg("staged_none"));
  return record;
}

/**
 * What applying the staged changes would do: the planned changes, the writable layer's changes that are lost, and the
 * terminal sessions that end. Nothing is changed. The checks a rebuild runs before its preview run here too.
 */
export async function previewStaged(
  host: HostCtx,
  box: Box,
  terminals: TerminalService | undefined,
): Promise<StagedPreview> {
  if (!(await readStaged(host, box))) throw new AppError(404, "not_found", msg("staged_none"));
  const record = requireStaged(host, box);
  const spec = specOf(host, box);
  let preview: RebuildPreview | null = null;
  try {
    await rebuildBox(host, box.id, spec.revision, requestOf(record.fields), false);
  } catch (e) {
    if (!(e instanceof AppError && e.code === "confirmation_required")) throw e;
    preview = (e.details as { preview: RebuildPreview }).preview;
  }
  if (!preview) throw new AppError(409, "conflict", msg("rebuild_confirm_required"));
  return {
    ...preview,
    sessions: await sessionCount(host, box, terminals),
    systemCheckpoint: systemLayerAllowed(spec.env),
    stagedAt: record.updatedAt,
  };
}

async function sessionCount(host: HostCtx, box: Box, terminals: TerminalService | undefined): Promise<number | null> {
  if (!box.running) return 0;
  if (!terminals) return null;
  try {
    return (await terminals.list(host, box)).length;
  } catch {
    return null;
  }
}

/**
 * Rebuilds the box with its staged changes and clears them once the rebuild has succeeded, unless more were staged
 * while it ran. With `checkpoint`, a checkpoint of the box's data and writable layer is taken first. A failed rebuild leaves the box and the staged
 * changes as they were. With `stagedAt`, changes staged after that preview are refused with 412 and nothing is done.
 */
export async function applyStaged(
  host: HostCtx,
  box: Box,
  revision: number,
  checkpoint: boolean,
  principalId: string,
  record?: RecordNote,
  stagedAt?: string,
): Promise<RebuildResult> {
  const view = await readStaged(host, box);
  if (!view) throw new AppError(404, "not_found", msg("staged_none"));
  const staged = requireStaged(host, box);
  if (stagedAt !== undefined && stagedAt !== staged.updatedAt) {
    throw new AppError(412, "precondition_failed", msg("staged_changed"), { stagedAt: staged.updatedAt });
  }
  const result = await rebuildWithSafety(
    host,
    box.id,
    revision,
    requestOf(staged.fields),
    true,
    record,
    checkpoint ? preRebuildSafety(host, principalId, { system: true }) : null,
  );
  // A change staged while the rebuild ran is kept: its fields that the rebuild applied drop out when it is next read.
  if (host.specs.staged.read(box.boxId)?.updatedAt === staged.updatedAt) host.specs.staged.remove(box.boxId);
  return result;
}
