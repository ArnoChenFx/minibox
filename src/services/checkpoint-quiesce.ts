import type { Consistency } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import { type Box, startLocked, getBox, locked } from "./boxes";
import type { Progress } from "./checkpoint-model";

/**
 * Makes the box consistent for the backup, and returns what undoes it. `pause` freezes a running box. `stop` stops it
 * and starts it again afterwards, when it was running. `live` leaves it alone. A stopped or sleeping box is read as it
 * is and nothing is started for it, so a checkpoint never wakes a box.
 *
 * Neither mode changes the box's desired state. A crash in the middle leaves the container paused, or stopped while
 * its desired state is still `running`, and startup reconciliation puts both right (see `reconcileHost`).
 */
export async function quiesce(
  host: HostCtx,
  box: Box,
  consistency: Consistency,
  progress?: Progress,
): Promise<() => Promise<void>> {
  if (!box.running || consistency === "live") return async () => {};
  if (consistency === "pause") {
    progress?.log?.("Pausing the box…\n");
    await host.runtime.pauseContainer(box.id);
    return () => resumeStep(box, progress, "Unpausing the box…\n", () => host.runtime.unpauseContainer(box.id));
  }
  progress?.log?.("Stopping the box…\n");
  await host.runtime.stopContainer(box.id, { timeoutSec: host.stopTimeoutSec });
  host.selfTokens.revoke(box.boxId);
  await host.sampler.observe(box.id);
  return () =>
    resumeStep(box, progress, "Starting the box again…\n", async () => {
      await startLocked(host, await getBox(host, box.boxId), {});
    });
}

/**
 * Resumes a box after its backup. The checkpoint is already recorded when this runs, so a failure is reported to the
 * task and logged rather than raised. Raising it would hide a checkpoint that exists and make a retry take another.
 */
async function resumeStep(
  box: Box,
  progress: Progress | undefined,
  start: string,
  step: () => Promise<unknown>,
): Promise<void> {
  progress?.log?.(start);
  try {
    await step();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    progress?.log?.(`The box could not be resumed: ${error}\n`);
    log.error("checkpoint.resume_failed", { box: box.name, error });
  }
}

/**
 * Runs `fn` under the box's power lock, and holds the box awake while it runs, so the idle watcher cannot sleep it and
 * its end counts as activity (#12). The box is read again under the lock, so a change made while this call waited is seen.
 * `quiet` keeps the hold but does not count its end as activity, for work the scheduler starts on its own.
 */
export async function underBox<T>(
  host: HostCtx,
  boxId: string,
  fn: (box: Box) => Promise<T>,
  opts: { quiet?: boolean } = {},
): Promise<T> {
  const release = host.pulse.hold(boxId, opts);
  try {
    return await locked(host, boxId, fn);
  } finally {
    release();
  }
}
