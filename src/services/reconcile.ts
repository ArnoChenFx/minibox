import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import { type ContainerInfo, HELPER_SECRETS_LABEL } from "../runtime";
import { ClaimError, ensureSpec } from "../specs/claim";
import { ttlExpired } from "../specs/lifetime";
import type { BoxSpec } from "../specs/types";
import { claimEngineVolumes } from "../volumes/engine";
import { sleepBox, startBox, stopBox } from "./boxes";
import { sweepEgress, syncHostFirewall } from "./egress";
import { settlePendingRollbacks } from "./rollback";

export interface ReconcileReport {
  /** Stable ids of containers that had no spec file and were claimed on this pass. */
  claimed: string[];
  /** Stable ids started because their desired state is `running`. */
  started: string[];
  /** Stable ids stopped because their desired state is `stopped`. */
  stopped: string[];
  /** Stable ids whose engine restart policy was set back to `no`. */
  restartReset: string[];
  /** Stable ids whose container was left paused, by a checkpoint a crash cut short, and was unpaused. */
  unpaused: string[];
  /** Stable ids whose rollback record a crash left stale (box gone, or undo cut short after its rebuild) and was settled. */
  rollbacksSettled: string[];
  /** Helper secret volumes a crash left behind, removed. */
  secretsRemoved: string[];
  /** Egress proxies and private networks that no box spec names, removed. These are container and network names. */
  egressRemoved: string[];
  /** Stable ids whose container is gone. The spec is kept. */
  missing: string[];
  /**
   * Boxes this pass could not reconcile, with the reason. The id is the stable id, or the container name for a
   * container that could not be claimed. The other boxes on the host are still reconciled.
   */
  failed: { id: string; error: string }[];
}

/**
 * Makes one host match its specs. The engine restart policy is `no` (decision D8): this pass is what starts or
 * stops a box. Resource, mount and image drift is reported on the box and is not repaired here.
 * The revision is not bumped, so an in-flight If-Match stays valid. A box that fails is recorded and logged, and
 * the pass goes on: one broken box must not keep the rest of the host down after a restart.
 */
export async function reconcileHost(host: HostCtx): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    claimed: [],
    started: [],
    stopped: [],
    restartReset: [],
    unpaused: [],
    rollbacksSettled: [],
    secretsRemoved: [],
    egressRemoved: [],
    missing: [],
    failed: [],
  };
  await claimEngineVolumes(host);
  const infos = await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } });
  const seen = new Set<string>();
  const live: ContainerInfo[] = [];

  for (const info of infos) {
    try {
      const claimed = await ensureSpec(host, info);
      if (!claimed) continue;
      seen.add(claimed.spec.id);
      live.push(info);
      if (claimed.created) report.claimed.push(claimed.spec.id);
    } catch (e) {
      if (e instanceof ClaimError) {
        log.warn("box.claim_skipped", { container: info.name, host: host.host.id, error: e.message });
        continue;
      }
      recordFailure(host, report, info.name, info.name, e);
    }
  }

  for (const spec of host.specs.list()) {
    if (spec.hostId === host.host.id && !seen.has(spec.id)) report.missing.push(spec.id);
  }

  try {
    await syncHostFirewall(host);
  } catch (e) {
    log.error("egress.firewall_sync_failed", { host: host.host.id, error: String(e) });
  }

  for (const info of live) {
    const spec = host.specs.findByContainer(info.id, info.name, host.host.id);
    if (!spec) continue;
    try {
      await converge(host, info, spec, report);
    } catch (e) {
      recordFailure(host, report, spec.id, info.name, e);
    }
  }
  try {
    report.rollbacksSettled = await settlePendingRollbacks(host);
  } catch (e) {
    log.error("checkpoint.rollback_settle_failed", { host: host.host.id, error: String(e) });
  }
  report.secretsRemoved = await removeStaleSecretVolumes(host);
  try {
    report.egressRemoved = await sweepEgress(host);
  } catch (e) {
    log.error("egress.sweep_failed", { host: host.host.id, error: String(e) });
  }
  return report;
}

/**
 * Removes the volumes that staged a helper's secrets and outlived it, because the process stopped between staging and
 * cleanup. Nothing runs a helper before reconciliation ends. Only this instance's volumes (its internal label) are
 * touched, and one still in use is refused by the engine and left.
 */
async function removeStaleSecretVolumes(host: HostCtx): Promise<string[]> {
  const removed: string[] = [];
  let volumes: Awaited<ReturnType<typeof host.runtime.listVolumes>>;
  try {
    volumes = await host.runtime.listVolumes();
  } catch (e) {
    log.warn("helper.secrets_sweep_failed", { host: host.host.id, error: String(e) });
    return removed;
  }
  for (const volume of volumes) {
    if (volume.labels[HELPER_SECRETS_LABEL] !== "true" || volume.labels[host.keys.internal] !== "true") continue;
    try {
      await host.runtime.removeVolume(volume.name);
      removed.push(volume.name);
    } catch (e) {
      log.warn("helper.secrets_remove_failed", { host: host.host.id, volume: volume.name, error: String(e) });
    }
  }
  return removed;
}

async function converge(host: HostCtx, info: ContainerInfo, spec: BoxSpec, report: ReconcileReport): Promise<void> {
  if (info.restart !== "no") {
    await host.runtime.updateContainer(info.id, { restart: "no" });
    report.restartReset.push(spec.id);
  }
  // Nothing pauses a box except a checkpoint in progress, and none is in progress at startup. A paused container is a
  // checkpoint the last process did not finish, and it still reports itself running.
  if (info.state === "paused") {
    await host.runtime.unpauseContainer(info.id);
    report.unpaused.push(spec.id);
  }
  if (spec.lifecycle.desired === "running" && !info.running) {
    if (ttlExpired(spec, Date.now())) {
      await sleepBox(host, spec.id, "ttl");
      report.stopped.push(spec.id);
    } else {
      await startBox(host, spec.id);
      report.started.push(spec.id);
    }
  } else if (spec.lifecycle.desired === "stopped" && info.running) {
    await stopBox(host, spec.id);
    report.stopped.push(spec.id);
  }
}

function recordFailure(host: HostCtx, report: ReconcileReport, id: string, container: string, e: unknown): void {
  const error = e instanceof Error ? e.message : String(e);
  report.failed.push({ id, error });
  log.error("box.reconcile_box_failed", { host: host.host.id, id, container, error });
}
