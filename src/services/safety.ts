import type { HostCtx } from "../host/registry";
import type { BoxEnv } from "../specs/types";
import { assertAutomaticAllowed } from "./checkpoint-capacity";
import { backupBox, boxLayers, deleteCheckpoint } from "./checkpoints";
import type { SafetyHook } from "./rebuild";

/** Whether a checkpoint may commit a box's writable layer: not when its env names a secret. */
export const systemLayerAllowed = (env: readonly BoxEnv[]): boolean =>
  env.every((entry) => entry.secretRef === undefined);

/**
 * The checkpoint a box rebuild takes before it changes anything. It is automatic, so a repository at its limit refuses
 * the rebuild, as it refuses a rollback. The box is paused for the copy, never stopped: a stop would restart through the
 * spec lock the rebuild already holds. A box with no checkpoint-owned volume has no data to keep and takes none.
 * With `system`, the writable layer the rebuild drops is committed into the checkpoint too, unless the box's env names
 * a secret, whose value must not reach an image: such a box keeps its data only.
 */
export function preRebuildSafety(host: HostCtx, createdBy: string | null, opts: { system?: boolean } = {}): SafetyHook {
  return async (box) => {
    const spec = host.specs.read(box.boxId);
    if (!spec) return null;
    const system = opts.system === true && systemLayerAllowed(spec.env);
    if (!system && boxLayers(host, spec).length === 0) return null;
    await assertAutomaticAllowed(host);
    const view = await backupBox(
      host,
      box,
      {
        label: "Before rebuild",
        reason: "Taken automatically before a box rebuild",
        pinned: false,
        include: { system, volumes: [] },
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
