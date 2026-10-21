import type { HostCtx } from "../host/registry";
import { forbidden } from "../lib/errors";
import { msg } from "../lib/messages";
import { isRuntimeError, type VolumeInfo } from "../runtime";
import type { BoxMount, BoxSpec } from "../specs/types";
import { ownedByAnotherBox } from "../volumes/engine";

/**
 * The volume the image mounts at `/data` (README: `-v minibox-data:/data`). It holds the access key and the sessions
 * file, so a box that mounted it could read both.
 */
export const DATA_VOLUME = "minibox-data";

/** Network modes that join the host's network namespace or another container's. */
const SHARED_NETWORK = /^(host|none|container:.*)$/;

export async function inspectVolumeOrNull(host: HostCtx, name: string): Promise<VolumeInfo | null> {
  try {
    return await host.runtime.inspectVolume(name);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  }
}

/**
 * Refuses a mount that `box` may not make (design §9.2). `box` is null while a box is being created. A volume the box
 * already mounts is kept, so only the data volume rule applies to it. `existing` is what the engine reports for the
 * volume, or null when MiniBox is about to create it. A standalone volume may be mounted by several boxes; a volume
 * owned by another live box may not.
 */
export function assertMountAllowed(
  host: HostCtx,
  box: BoxSpec | null,
  volume: string,
  existing: VolumeInfo | null,
): void {
  if (volume === DATA_VOLUME) throw forbidden(msg("volume_reserved", { volume }));
  if (box?.mounts.some((mount) => mount.volume === volume)) return;
  if (existing && existing.labels[host.keys.box] !== "true") throw forbidden(msg("volume_unmanaged", { volume }));
  if (ownedByAnotherBox(host, box?.id ?? null, volume)) throw forbidden(msg("volume_in_use", { volume }));
}

/**
 * Maps each requested mount to the engine volume it names: the engine name of a recorded volume, or the name as given
 * when no record exists (the engine check then decides, and a new name is created).
 */
export function engineRefs(host: HostCtx, mounts: BoxMount[]): BoxMount[] {
  return mounts.map((mount) => {
    const record = host.volumes.resolve(mount.volume, host.host.id);
    if (!record || record.hostId !== host.host.id) return mount;
    return { ...mount, volume: record.engineName };
  });
}

/** Checks a rebuild's mounts and network before the preview is returned, so a refused request changes nothing. */
export async function assertRebuildAttachments(
  host: HostCtx,
  box: BoxSpec,
  mounts: BoxMount[],
  network: string,
): Promise<void> {
  for (const mount of mounts) {
    assertMountAllowed(host, box, mount.volume, await inspectVolumeOrNull(host, mount.volume));
  }
  assertNetworkAllowed(host, box, network);
}

/**
 * A rebuilt box joins the host's box network, which MiniBox creates with inter-container communication off. A box
 * that runs on another network keeps it while the request leaves the network alone, so boxes created before the box
 * network still work. Host, none and container networks are refused even then.
 */
function assertNetworkAllowed(host: HostCtx, box: BoxSpec, network: string): void {
  if (SHARED_NETWORK.test(network)) throw forbidden(msg("network_reserved", { network }));
  if (network === host.security.network || network === box.network) return;
  throw forbidden(msg("network_not_managed", { network, managed: host.security.network }));
}
