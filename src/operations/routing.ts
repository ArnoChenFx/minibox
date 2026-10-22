import type { HostCtx } from "../host/registry";
import { untilAborted } from "../lib/abort";
import { AppError, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type FeatureKey, msg } from "../lib/messages";
import type { OperationContext } from "./types";

/** The host with this id. An id no host carries is a 404. */
export function hostById(ctx: OperationContext, hostId: string): HostCtx {
  const found = (ctx.allHosts?.() ?? [ctx.host]).find((host) => host.host.id === hostId);
  if (!found) throw notFound(msg("host_not_found", { host: hostId }));
  return found;
}

/**
 * The host a box reference names, by its spec: the id, the name, or the container name. A reference no spec covers stays
 * on the request's host, which is what a box that has never been seen on any host has always done.
 */
export function hostOfBox(ctx: OperationContext, ref: string): HostCtx {
  const specs = ctx.host.specs;
  const spec = specs.read(ref) ?? specs.findByName(ref) ?? specs.findByContainer(ref, ref);
  return spec ? hostById(ctx, spec.hostId) : ctx.host;
}

/** The host a volume lives on. Volume ids and names are looked up across the control plane. */
export function hostOfVolume(ctx: OperationContext, ref: string): HostCtx {
  const record = ctx.host.volumes.resolve(ref);
  return record ? hostById(ctx, record.hostId) : ctx.host;
}

export function hostOfCheckpoint(ctx: OperationContext, id: string): HostCtx {
  const record = ctx.host.checkpoints.read(id);
  return record ? hostById(ctx, record.hostId) : ctx.host;
}

/** The host an exec runs on, while the exec is still known. An exec that has ended keeps its output on any host. */
export function hostOfExec(ctx: OperationContext, execId: string): HostCtx {
  const found = ctx.execs?.lookup(execId);
  return found ? hostById(ctx, found.hostId) : ctx.host;
}

/**
 * Reads every host at once, for a list whose items live on all of them. The local host's failure fails the list, as it
 * always has. A remote host that is offline, slow or failing contributes nothing, and is logged, so it cannot hold up
 * the others.
 */
export async function fromEveryHost<T>(hosts: readonly HostCtx[], read: (host: HostCtx) => Promise<T[]>): Promise<T[]> {
  const groups = await Promise.all(
    hosts.map(async (host): Promise<T[]> => {
      if (host.host.transport === "local") return read(host);
      if (host.host.status === "offline") return [];
      try {
        return await untilAborted(read(host), AbortSignal.timeout(host.readTimeoutMs));
      } catch (e) {
        log.warn("host.list_skipped", { host: host.host.id, error: String(e) });
        return [];
      }
    }),
  );
  return groups.flat();
}

/** Refuses a feature that has no remote form yet. The local host always passes. */
export function localOnly(host: HostCtx, feature: FeatureKey): void {
  if (host.host.transport === "local") return;
  throw new AppError(501, "unsupported", msg("host_unsupported", { feature }));
}
