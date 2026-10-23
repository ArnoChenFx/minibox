import type { HostCtx } from "../host/registry";
import { conflict, forbidden, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { VolumeInfo } from "../runtime";
import type { BoxMount, BoxSpec } from "../specs/types";
import { claimOne, inspectVolumeOrNull, isSharedTools, ownedByAnotherBox } from "../volumes/engine";
import { isVolumeId } from "../volumes/id";
import { assertMountsWithinLimits } from "../volumes/limits";
import type { VolumeRecord } from "../volumes/types";

/**
 * The volume the image mounts at `/data` (see docs/admin/install.md). It holds the access key and the sessions
 * file, so a box that mounted it could read both.
 */
export const DATA_VOLUME = "minibox-data";

/** Network modes that join the host's network namespace or another container's. */
const SHARED_NETWORK = /^(host|none|container:.*)$/;

/** The engine volume a mount names, and the record MiniBox keeps for it. Either can be missing. */
export interface MountTarget {
  info: VolumeInfo | null;
  record: VolumeRecord | null;
}

/**
 * Looks up what a mount names. A labelled volume with no record is claimed first, so the record-based rules in
 * `assertMountAllowed` see every volume MiniBox manages.
 */
export async function mountTarget(host: HostCtx, engineName: string): Promise<MountTarget> {
  const info = await inspectVolumeOrNull(host, engineName);
  const record = host.volumes.findByEngine(host.host.id, engineName) ?? (info ? await claimOne(host, info) : null);
  return { info, record };
}

/**
 * Refuses a mount that `box` may not make. `box` is null while a box is being created.
 * - The data volume, the pool roots and internal helper volumes are always refused.
 * - A volume the box already mounts is kept, unless the engine no longer has it.
 * - A recorded or already-mounted volume that the engine no longer has is refused, never recreated. The exception is a
 *   shared tools record, which the create, start or rebuild that mounts it recreates before the engine needs it.
 * - A volume without the MiniBox box label is refused.
 * - A record owned by another live box is refused. Standalone records may be mounted by several boxes.
 * - A name that does not exist yet is allowed, except ids and the workspace prefix (`<prefix>-ws-`).
 */
export function assertMountAllowed(host: HostCtx, box: BoxSpec | null, volume: string, target: MountTarget): void {
  const shown = target.record?.name ?? volume;
  const reserved =
    volume === DATA_VOLUME ||
    volume.startsWith(`${host.prefix}-pool-`) ||
    target.info?.labels[host.keys.internal] === "true";
  if (reserved) throw forbidden(msg("volume_reserved", { volume: shown }));
  const kept = box?.mounts.some((mount) => mount.volume === volume) ?? false;
  if (!target.info) {
    if (target.record && isSharedTools(host, target.record)) return;
    if (target.record || kept) throw conflict(msg("volume_missing", { volume: shown }));
    if (isVolumeId(volume)) throw notFound(msg("volume_not_found", { volume }));
    if (volume.startsWith(`${host.prefix}-ws-`)) throw forbidden(msg("volume_reserved", { volume: shown }));
    return;
  }
  if (kept) return;
  if (target.info.labels[host.keys.box] !== "true") throw forbidden(msg("volume_unmanaged", { volume: shown }));
  if (ownedByAnotherBox(host, box?.id ?? null, volume)) throw forbidden(msg("volume_in_use", { volume: shown }));
}

/**
 * Maps each requested mount to the engine volume it names: the engine name of a recorded volume, or the name as given
 * when no record exists (the attachment rules then decide, and a new name is created).
 */
export function engineRefs(host: HostCtx, mounts: BoxMount[]): BoxMount[] {
  return mounts.map((mount) => {
    const record = host.volumes.resolve(mount.volume, host.host.id);
    if (!record || record.hostId !== host.host.id) return mount;
    return { ...mount, volume: record.engineName };
  });
}

/**
 * Checks a rebuild's mounts and network before the preview is returned, so a refused request changes nothing. A rebuilt
 * box with egress joins its own private network, which the planner names, so `privateNetwork` lets that one through.
 */
export async function assertRebuildAttachments(
  host: HostCtx,
  box: BoxSpec,
  mounts: BoxMount[],
  network: string,
  privateNetwork: boolean,
): Promise<void> {
  for (const mount of mounts) {
    assertMountAllowed(host, box, mount.volume, await mountTarget(host, mount.volume));
  }
  assertMountsWithinLimits(host, mounts);
  assertNetworkAllowed(host, box, network, privateNetwork);
}

/**
 * A rebuilt box joins the host's box network, which MiniBox creates with inter-container communication off. A box
 * that runs on another network keeps it while the request leaves the network alone, so boxes created before the box
 * network still work. Host, none and container networks are refused even then.
 */
function assertNetworkAllowed(host: HostCtx, box: BoxSpec, network: string, privateNetwork: boolean): void {
  if (SHARED_NETWORK.test(network)) throw forbidden(msg("network_reserved", { network }));
  if (privateNetwork || network === host.security.network || network === box.network) return;
  throw forbidden(msg("network_not_managed", { network, managed: host.security.network }));
}
