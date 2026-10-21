import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import type { ContainerInfo } from "../runtime";
import { ClaimError, ensureSpec } from "../specs/claim";
import { ttlExpired } from "../specs/lifetime";
import type { BoxSpec } from "../specs/types";
import { claimEngineVolumes } from "../volumes/engine";
import { sleepBox, startBox, stopBox } from "./boxes";

export interface ReconcileReport {
  /** Stable ids of containers that had no spec file and were claimed on this pass. */
  claimed: string[];
  /** Stable ids started because their desired state is `running`. */
  started: string[];
  /** Stable ids stopped because their desired state is `stopped`. */
  stopped: string[];
  /** Stable ids whose engine restart policy was set back to `no`. */
  restartReset: string[];
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
  const report: ReconcileReport = { claimed: [], started: [], stopped: [], restartReset: [], missing: [], failed: [] };
  await claimEngineVolumes(host);
  const infos = await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } });
  const seen = new Set<string>();
  const live: ContainerInfo[] = [];

  for (const info of infos) {
    try {
      const { spec, created } = await ensureSpec(host, info);
      seen.add(spec.id);
      live.push(info);
      if (created) report.claimed.push(spec.id);
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

  for (const info of live) {
    const spec = host.specs.findByContainer(info.id, info.name);
    if (!spec || spec.hostId !== host.host.id) continue;
    try {
      await converge(host, info, spec, report);
    } catch (e) {
      recordFailure(host, report, spec.id, info.name, e);
    }
  }
  return report;
}

async function converge(host: HostCtx, info: ContainerInfo, spec: BoxSpec, report: ReconcileReport): Promise<void> {
  if (info.restart !== "no") {
    await host.runtime.updateContainer(info.id, { restart: "no" });
    report.restartReset.push(spec.id);
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
