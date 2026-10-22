import type { HostCtx } from "../host/registry";
import { assertAutomaticAllowed } from "./checkpoint-capacity";
import { backupBox, boxLayers, deleteCheckpoint } from "./checkpoints";
import type { SafetyHook } from "./rebuild";

/**
 * The checkpoint a box rebuild takes before it changes anything. It is automatic, so a repository at its limit refuses
 * the rebuild, as it refuses a rollback. The box is paused for the copy, never stopped: a stop would restart through the
 * spec lock the rebuild already holds. A box with no checkpoint-owned volume has no data to keep and takes none.
 */
export function preRebuildSafety(host: HostCtx, createdBy: string | null): SafetyHook {
  return async (box) => {
    const spec = host.specs.read(box.boxId);
    if (!spec || boxLayers(host, spec).length === 0) return null;
    await assertAutomaticAllowed(host);
    const view = await backupBox(
      host,
      box,
      {
        label: "Before rebuild",
        reason: "Taken automatically before a box rebuild",
        pinned: false,
        include: { system: false, volumes: [] },
        consistency: "pause",
      },
      createdBy,
      undefined,
      true,
    );
    return {
      id: view.id,
      label: view.label,
      discard: () => deleteCheckpoint(host, view.id),
    };
  };
}
