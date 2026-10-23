import type { HostCtx } from "../host/registry";
import { toAppError } from "../lib/errors";
import type { Msg, Params } from "../lib/messages";

/** Why one volume step failed: its text for people, and the key and params a translated client shows instead. */
export interface OutcomeError {
  message: string;
  key: string | null;
  params: Params | null;
}

export function errorOutcome(error: unknown): OutcomeError {
  const app = toAppError(error);
  return { message: app.message, key: app.key ?? null, params: app.params ?? null };
}

export function messageOutcome(message: Msg): OutcomeError {
  return { message: message.text, key: message.key, params: message.params ?? null };
}

/** A remote host the control plane has marked offline. Its volumes cannot be checked, so they are reported and skipped. */
export function hostOffline(host: HostCtx): boolean {
  return host.host.transport !== "local" && host.host.status === "offline";
}

/**
 * Engine volume names that something still uses on this host: a box spec, a container in any state, or a rollback that
 * keeps a volume until it is confirmed or undone. Rejects when the engine cannot list its containers.
 */
export async function volumesInUse(host: HostCtx): Promise<Set<string>> {
  const names = new Set<string>();
  for (const spec of host.specs.list()) {
    for (const mount of spec.mounts) names.add(mount.volume);
  }
  const containers = await host.runtime.listContainers(
    { labels: {} },
    { signal: AbortSignal.timeout(host.readTimeoutMs) },
  );
  for (const container of containers) {
    for (const mount of container.mounts) names.add(mount.source);
  }
  for (const pending of host.checkpoints.pendingRollbacks()) {
    if (pending.hostId !== host.host.id) continue;
    for (const volume of [...pending.replaced, ...pending.restored]) names.add(volume.engineName);
  }
  return names;
}
