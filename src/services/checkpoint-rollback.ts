import { type DataLayer, type PendingRollback, ROLLBACK_VERSION, type RolledVolume } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { notFound, conflict, AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { ContainerChange } from "../runtime";
import { REBUILD_LOSES } from "../specs/plan";
import { revisionMismatch } from "../specs/revision";
import type { BoxSpec, BoxMount } from "../specs/types";
import { VolumeChanges } from "../volumes/changes";
import { createRestoredVolume } from "../volumes/provision";
import type { VolumeRecord } from "../volumes/types";
import { type Box, getBox, refuseExpired } from "./boxes";
import { assertAutomaticAllowed } from "./checkpoint-capacity";
import { slug, restoreLayer } from "./checkpoint-layers";
import {
  type CheckpointView,
  type RollbackPreview,
  ROLLBACK_KEEPS,
  type Progress,
  type RollbackResult,
  type TakeCheckpointInput,
} from "./checkpoint-model";
import { underBox } from "./checkpoint-quiesce";
import { backupBox } from "./checkpoint-take";
import { getCheckpoint } from "./checkpoint-view";
import { rebuildBox } from "./rebuild";
import type { RecordNote } from "./volume-owner";

interface RollbackPlan {
  box: Box;
  spec: BoxSpec;
  checkpoint: CheckpointView;
  restores: { layer: DataLayer; mount: BoxMount; volume: VolumeRecord }[];
}

/**
 * Matches each owned layer of the checkpoint to the box's current owned volume at the same path. Shared volumes are not
 * part of a rollback, so they are never matched. A checkpoint of another box, or one with no volume data, is refused.
 * A box with a rollback still waiting for its confirm or undo is refused too: that rollback's volumes are not replaced.
 */
export async function planRollback(
  host: HostCtx,
  boxRef: string,
  checkpointRef: string,
  revision: number,
): Promise<RollbackPlan> {
  const box = await getBox(host, boxRef);
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);
  if (host.checkpoints.pendingRollback(box.boxId)) throw conflict(msg("rollback_pending", { box: box.name }));
  const checkpoint = await getCheckpoint(host, checkpointRef);
  const owned = checkpoint.data.filter((layer) => layer.ownership === "owned");
  if (owned.length === 0) throw conflict(msg("checkpoint_no_data", { id: checkpoint.id }));
  if (checkpoint.boxId !== box.boxId) throw conflict(msg("checkpoint_other_box", { id: checkpoint.id }));
  const restores = owned.map((layer) => {
    const mount = spec.mounts.find((item) => item.path === layer.path);
    const volume = mount ? host.volumes.findByEngine(host.host.id, mount.volume) : null;
    // A volume outside checkpoints has no safety copy, so a rollback never replaces one.
    if (!mount || !volume || !volume.checkpoint || volume.ownership !== "owned" || volume.ownerBoxId !== box.boxId) {
      throw conflict(msg("checkpoint_path_not_mounted", { path: layer.path }));
    }
    return { layer, mount, volume };
  });
  return { box, spec, checkpoint, restores };
}

function rollbackPreview(plan: RollbackPlan, diff: ContainerChange[]): RollbackPreview {
  return {
    checkpoint: { id: plan.checkpoint.id, label: plan.checkpoint.label, createdAt: plan.checkpoint.createdAt },
    restores: plan.restores.map(({ mount, volume }) => ({ path: mount.path, role: volume.role, volume: volume.name })),
    keeps: ROLLBACK_KEEPS,
    loses: REBUILD_LOSES,
    diff,
    revision: { current: plan.spec.revision, next: plan.spec.revision + 1 },
  };
}

/** What a rollback would do, read without changing anything. A revision other than the box's current one is refused. */
export async function previewRollback(
  host: HostCtx,
  boxRef: string,
  checkpointRef: string,
  revision: number,
): Promise<RollbackPreview> {
  const plan = await planRollback(host, boxRef, checkpointRef, revision);
  const diff = await host.runtime.containerDiff(plan.spec.containerId);
  return rollbackPreview(plan, diff);
}

/** The refusal a rollback without `confirm` gets. Nothing has changed, and the preview says what a confirmed call does. */
export function rollbackConfirmation(preview: RollbackPreview): AppError {
  return new AppError(409, "confirmation_required", msg("checkpoint_rollback_confirm"), { preview });
}

/**
 * Rolls a box back to one of its own checkpoints. Each owned volume's data is restored into a new volume, and the box is
 * rebuilt onto those volumes, which keeps the rebuild's checks. The volumes it replaces are kept until the rollback is
 * confirmed, which deletes them, or undone (see `services/rollback.ts`). Without `confirm` nothing changes, and a 409
 * carries the preview.
 */
export async function rollbackBox(
  host: HostCtx,
  boxRef: string,
  input: { checkpoint: string; confirm: boolean; revision: number },
  createdBy: string | null,
  progress?: Progress,
  record?: RecordNote,
): Promise<RollbackResult> {
  if (!input.confirm) throw rollbackConfirmation(await previewRollback(host, boxRef, input.checkpoint, input.revision));
  const { boxId } = await getBox(host, boxRef);
  return underBox(host, boxId, () => restoreUnderLock(host, boxId, input, createdBy, progress, record));
}

/**
 * A confirmed rollback, run under the box's power lock. The box is refused first when its lifetime has ended, before any
 * volume is made, as a rebuild starts the box too (decision 53). The box's owned volumes are then backed up as an
 * automatic safety checkpoint, with the box stopped, so the data the rollback replaces survives whatever
 * follows.
 *
 * The rollback record is written only once the box runs on the restored volumes. Written earlier, it would name volumes
 * the box still mounts. A crash before that leaves the replaced volumes unlisted and unharmed, and nothing is deleted
 * without a record. A failure to write it must not undo the rebuild, because the box already mounts the restored volumes.
 */
async function restoreUnderLock(
  host: HostCtx,
  boxId: string,
  input: { checkpoint: string; revision: number },
  createdBy: string | null,
  progress: Progress | undefined,
  record: RecordNote | undefined,
): Promise<RollbackResult> {
  refuseExpired(host, boxId);
  const first = await planRollback(host, boxId, input.checkpoint, input.revision);
  await assertAutomaticAllowed(host);
  progress?.log?.("Taking a safety checkpoint…\n");
  const safety = await backupBox(host, first.box, safetyInput(first.checkpoint), createdBy, progress, true);
  const plan = await planRollback(host, boxId, input.checkpoint, input.revision);
  const { box, restored } = await mountRestored(host, plan, createdBy, progress, record);
  const pending: PendingRollback = {
    version: ROLLBACK_VERSION,
    hostId: host.host.id,
    boxId: plan.spec.id,
    boxName: plan.spec.name,
    checkpointId: plan.checkpoint.id,
    checkpointLabel: plan.checkpoint.label,
    safetyCheckpointId: safety.id,
    createdBy,
    createdAt: new Date().toISOString(),
    replaced: plan.restores.map(({ mount, volume }) => rolledOf(volume, mount.path)),
    restored,
  };
  host.checkpoints.writePendingRollback(pending);
  log.info("checkpoint.rolled_back", { checkpoint: plan.checkpoint.id, box: plan.spec.name, safety: safety.id });
  return {
    box,
    replaced: plan.restores.map(({ volume }) => ({ id: volume.id, name: volume.name })),
    safety: { id: safety.id, label: safety.label },
  };
}

/**
 * Restores each owned layer into a new volume, then rebuilds the box onto them. A failure takes back the volumes made
 * here. The rebuild has already put the box back as it was, so nothing else needs undoing.
 */
async function mountRestored(
  host: HostCtx,
  plan: RollbackPlan,
  createdBy: string | null,
  progress: Progress | undefined,
  record: RecordNote | undefined,
): Promise<{ box: Box; restored: RolledVolume[] }> {
  const known = new Set<string>();
  const changes = new VolumeChanges();
  const restored: RolledVolume[] = [];
  try {
    for (const { layer, mount, volume } of plan.restores) {
      progress?.log?.(`Restoring ${mount.path}…\n`);
      const fresh = await createRestoredVolume(
        host,
        {
          name: `${plan.spec.name}-${volume.role ?? slug(mount.path)}`,
          role: volume.role,
          owner: plan.spec.id,
          createdBy,
        },
        known,
        changes,
      );
      await restoreLayer(host, layer, fresh);
      restored.push(rolledOf(fresh, mount.path));
    }
    const mounts = plan.spec.mounts.map((mount) => {
      const fresh = restored.find((item) => item.path === mount.path);
      return fresh ? { ...mount, volume: fresh.engineName } : mount;
    });
    const box = await rebuildBox(host, plan.spec.id, plan.spec.revision, { mounts }, true, record);
    return { box, restored };
  } catch (e) {
    await changes.rollback();
    throw e;
  }
}

function rolledOf(volume: VolumeRecord, path: string): RolledVolume {
  return { volumeId: volume.id, name: volume.name, engineName: volume.engineName, path };
}

/** The checkpoint a rollback takes before it replaces anything. The box is stopped for it. */
function safetyInput(target: CheckpointView): TakeCheckpointInput {
  return {
    label: `Before rollback to ${target.label}`,
    reason: `Taken automatically before a rollback to ${target.id}`,
    pinned: false,
    include: { system: false, volumes: [] },
    consistency: "stop",
  };
}
