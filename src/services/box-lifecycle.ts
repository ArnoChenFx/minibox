import type { HostCtx } from "../host/registry";
import { conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { assertSecretsStartable } from "../secrets/env";
import { pushHistory } from "../specs/history";
import { ttlExpired } from "../specs/lifetime";
import type { DesiredState, StopReason, BoxEnv } from "../specs/types";
import { assertVolumesPresent, healSharedToolsMounts, noteUnmounted, poolsUsed } from "../volumes/engine";
import { assertPoolsReachable } from "../volumes/health";
import { assertMountsWithinLimits } from "../volumes/limits";
import { removeEngine } from "../volumes/provision";
import type { VolumeRecord } from "../volumes/types";
import type { Box, StartOptions, EnsureResult, DeleteBoxOptions, DeleteBoxResult } from "./box-model";
import { attachToBoxNetwork } from "./box-network";
import { getBox } from "./box-query";
import { prepareEgress, removeEgress, stopEgressProxies, syncHostFirewall } from "./egress";
import { deliverSelfToken } from "./self-token";
import { startupNow } from "./startup";

/** Bumps the revision only when the desired state actually changes, so a reconcile does not invalidate If-Match. */
async function setDesired(
  host: HostCtx,
  boxId: string,
  desired: DesiredState,
  stopReason: StopReason | null = desired === "stopped" ? "manual" : null,
): Promise<void> {
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(boxId);
    if (!spec) return;
    const prevReason = spec.lifecycle.stopReason ?? null;
    const nextReason = desired === "running" ? null : stopReason;
    if (spec.lifecycle.desired === desired && prevReason === nextReason) return;
    const bumpDesired = spec.lifecycle.desired !== desired;
    host.specs.write({
      ...spec,
      lifecycle: { ...spec.lifecycle, desired, stopReason: nextReason },
      revision: bumpDesired ? spec.revision + 1 : spec.revision,
      updatedAt: new Date().toISOString(),
      history: bumpDesired ? pushHistory(spec) : spec.history,
    });
  });
}

/**
 * Start and restart refuse a box whose pool is unreachable or whose volume is gone, instead of letting Docker recreate it.
 * The exception is a shared tools volume the engine lost, which is recreated first.
 */
async function ensureRunningStorage(host: HostCtx, box: Box): Promise<void> {
  const spec = host.specs.read(box.boxId);
  const mounts = spec?.mounts ?? box.mounts;
  await assertPoolsReachable(host, poolsUsed(host, mounts));
  await healSharedToolsMounts(
    host,
    mounts.map((mount) => mount.volume),
    new Set(),
  );
  await assertVolumesPresent(
    host,
    mounts.map((mount) => mount.volume),
  );
}

/**
 * Runs `fn` with the box's power lock held. The box is read again inside the lock, so a change made while this call was
 * waiting is seen.
 */
export async function locked<T>(host: HostCtx, ref: string, fn: (box: Box) => Promise<T>): Promise<T> {
  const { boxId } = await getBox(host, ref);
  return host.power.run(boxId, async () => fn(await getBox(host, boxId)));
}

/**
 * An expired TTL refuses every start and restart, so a box cannot outlive its lifetime by being woken again (#12). A
 * rebuild starts the new container too, so it calls this as well.
 */
export function refuseExpired(host: HostCtx, boxId: string): void {
  const spec = host.specs.read(boxId);
  if (spec && ttlExpired(spec, Date.now())) {
    throw conflict(msg("box_ttl_expired"), { hint: msg("box_ttl_expired_hint") });
  }
}

/** The env a box's spec names. Start and restart check it, because neither recreates the container. */
function storedEnv(host: HostCtx, boxId: string): BoxEnv[] {
  return host.specs.read(boxId)?.env ?? [];
}

/** Starts the box for a caller that already holds its power lock (see `locked`). */
export async function startLocked(host: HostCtx, box: Box, options: StartOptions): Promise<Box> {
  if (!box.running) {
    refuseExpired(host, box.boxId);
    assertSecretsStartable(host.secrets, storedEnv(host, box.boxId));
    assertMountsWithinLimits(host, host.specs.read(box.boxId)?.mounts ?? box.mounts);
  }
  const previousReason = (host.specs.read(box.boxId)?.lifecycle.stopReason ?? null) as StopReason | null;
  await ensureRunningStorage(host, box);
  await attachToBoxNetwork(host, box);
  await prepareEgress(host, box);
  try {
    await host.runtime.startContainer(box.id);
  } catch (e) {
    await stopProxiesOf(host, box.boxId);
    throw e;
  }
  await setDesired(host, box.boxId, "running", null);
  if (!box.running || !host.selfTokens.has(box.boxId)) await deliverSelfToken(host, box.boxId, box.id);
  await host.sampler.observe(box.id);
  host.pulse.touch(box.boxId, "wake");
  if (!box.running) await startupNow(host, box.boxId);
  if (options.record && (previousReason === "idle" || previousReason === "ttl")) {
    options.record({
      op: "box.wake",
      kind: "write",
      status: "ok",
      summary: `Box woke: ${box.name}`,
      target: { kind: "box", id: box.id, name: box.name },
      detail: { boxId: box.boxId, from: previousReason },
    });
  }
  return getBox(host, box.boxId);
}

/** Starts the box. Starting a running box leaves its container alone. */
export async function startBox(host: HostCtx, ref: string, options: StartOptions = {}): Promise<Box> {
  return locked(host, ref, (box) => startLocked(host, box, options));
}

/** Starts a stopped box whatever stopped it. Exec and sessions use this, as a stopped box is started for them. */
export async function ensureRunning(host: HostCtx, ref: string, options: StartOptions = {}): Promise<EnsureResult> {
  return locked(host, ref, async (box) => {
    if (box.running) return { box, woke: false };
    return { box: await startLocked(host, box, options), woke: true };
  });
}

/**
 * Wakes a box that is asleep, which is stopped for idle or TTL. A box a person stopped, or one that is running, comes back
 * unchanged. Terminal and preview requests use this, so a manual stop still stops them.
 */
export async function wakeIfSleeping(host: HostCtx, ref: string, options: StartOptions = {}): Promise<Box> {
  return locked(host, ref, async (box) => (box.sleeping ? startLocked(host, box, options) : box));
}

/** Stops the box for a caller that already holds its power lock (see `locked`). */
async function stopLocked(host: HostCtx, box: Box, reason?: StopReason): Promise<void> {
  await host.runtime.stopContainer(box.id, { timeoutSec: host.stopTimeoutSec });
  await stopProxiesOf(host, box.boxId);
  host.selfTokens.revoke(box.boxId);
  const existing = host.specs.read(box.boxId)?.lifecycle.stopReason ?? null;
  // Omitted reason: keep an existing idle/ttl reason (reconcile), otherwise mark manual.
  const next: StopReason = reason ?? existing ?? "manual";
  await setDesired(host, box.boxId, "stopped", next);
  await host.sampler.observe(box.id);
}

/** A box with egress has a proxy to stop with it. A box on the default network has none, and makes no engine call. */
async function stopProxiesOf(host: HostCtx, boxId: string): Promise<void> {
  if (host.specs.read(boxId)?.egress) await stopEgressProxies(host, boxId);
}

export async function stopBox(host: HostCtx, ref: string, reason?: StopReason): Promise<Box> {
  return locked(host, ref, async (box) => {
    await stopLocked(host, box, reason);
    return getBox(host, box.boxId);
  });
}

/**
 * Puts a box to sleep for `idle` or `ttl`. `stillIdle` runs under the box's lock, on the box as it is then, so a request
 * that arrived after the decision keeps the box awake. Returns false when the box was left running.
 */
export async function sleepBox(
  host: HostCtx,
  ref: string,
  reason: "idle" | "ttl",
  stillIdle: (box: Box) => boolean | Promise<boolean> = () => true,
): Promise<boolean> {
  return locked(host, ref, async (box) => {
    if (!(await stillIdle(box))) return false;
    await stopLocked(host, box, reason);
    return true;
  });
}

export async function restartBox(host: HostCtx, ref: string): Promise<Box> {
  return locked(host, ref, async (box) => {
    refuseExpired(host, box.boxId);
    assertSecretsStartable(host.secrets, storedEnv(host, box.boxId));
    assertMountsWithinLimits(host, host.specs.read(box.boxId)?.mounts ?? box.mounts);
    await ensureRunningStorage(host, box);
    await attachToBoxNetwork(host, box);
    await prepareEgress(host, box);
    host.selfTokens.revoke(box.boxId);
    await host.runtime.restartContainer(box.id, { timeoutSec: host.stopTimeoutSec });
    await setDesired(host, box.boxId, "running", null);
    await deliverSelfToken(host, box.boxId, box.id);
    await host.sampler.observe(box.id);
    // Same as a start: clear a stale idle heartbeat so LifecycleWatcher does not re-sleep the box at once.
    host.pulse.touch(box.boxId, "wake");
    await startupNow(host, box.boxId);
    return getBox(host, box.boxId);
  });
}

export async function deleteBox(
  host: HostCtx,
  ref: string,
  deleteVolume: boolean,
  opts: DeleteBoxOptions = {},
): Promise<DeleteBoxResult> {
  return locked(host, ref, async (box) => {
    const spec = host.specs.read(box.boxId);
    const mounted = (spec?.mounts ?? [])
      .map((mount) => host.volumes.findByEngine(host.host.id, mount.volume))
      .filter((volume): volume is VolumeRecord => volume !== null);
    // A rollback still waiting for its confirm or undo keeps the volumes it replaced. They are the box's, so they go with it.
    const replaced = (host.checkpoints.pendingRollback(box.boxId)?.replaced ?? [])
      .map((volume) => host.volumes.read(volume.volumeId))
      .filter((volume): volume is VolumeRecord => volume !== null);
    const trash = opts.keep ? await opts.keep(box) : null;
    try {
      await host.specs.exclusive(async () => {
        await host.runtime.removeContainer(box.id, { force: true });
        host.selfTokens.revoke(box.boxId);
        host.specs.retire(box.id);
        host.specs.remove(box.boxId);
      });
    } catch (e) {
      if (trash !== null && box.running) await restartAfterFailedDelete(host, box);
      throw e;
    }
    if (spec?.egress) await dropEgress(host, box.boxId);
    host.questions.forget(box.boxId);
    await host.sampler.observe(box.id);
    host.pulse.clear(box.boxId);
    const result: DeleteBoxResult = { name: box.name, volumeDeleted: false, trash };
    if (deleteVolume) await removeOwnedVolumes(host, box.boxId, [...mounted, ...replaced], result);
    noteUnmounted(
      host,
      { boxId: box.boxId, name: box.name },
      mounted.map((volume) => volume.engineName),
    );
    host.checkpoints.removePendingRollback(box.boxId);
    log.info("box.deleted", { name: box.name, volumeDeleted: result.volumeDeleted });
    return result;
  });
}

/**
 * Removes a deleted box's proxy and private network, then sets the firewall without its source. The box is already gone,
 * so a failure here is logged; the sweep at startup removes whatever is left.
 */
async function dropEgress(host: HostCtx, boxId: string): Promise<void> {
  await removeEgress(host, boxId).catch((e: unknown) => {
    log.warn("box.delete_egress_failed", { id: boxId, error: String(e) });
  });
  await syncHostFirewall(host).catch((e: unknown) => {
    log.warn("box.delete_egress_failed", { id: boxId, error: String(e) });
  });
}

/** The keep step stops a running box for its copy, so a removal that fails after it starts the box again. */
async function restartAfterFailedDelete(host: HostCtx, box: Box): Promise<void> {
  try {
    await startLocked(host, { ...box, running: false }, {});
  } catch (e) {
    log.warn("box.delete_restart_failed", { id: box.boxId, error: String(e) });
  }
}

/**
 * Removes the volumes this box owns that no other box mounts. Only a record that names this box as owner is removed.
 * A volume with no record, or one owned by another box, is never touched. Failures are reported, not thrown.
 */
async function removeOwnedVolumes(
  host: HostCtx,
  boxId: string,
  mounted: VolumeRecord[],
  result: DeleteBoxResult,
): Promise<void> {
  const remaining = host.specs.list();
  let removed = 0;
  for (const volume of mounted) {
    if (volume.ownership !== "owned" || volume.ownerBoxId !== boxId) continue;
    if (remaining.some((other) => other.mounts.some((mount) => mount.volume === volume.engineName))) continue;
    const outcome = await removeEngine(host, volume.engineName);
    if (outcome.status === "failed") {
      result.volumeError ??= outcome.detail;
      continue;
    }
    host.volumes.remove(volume.id);
    removed += 1;
  }
  result.volumeDeleted = removed > 0 && result.volumeError === undefined;
}
