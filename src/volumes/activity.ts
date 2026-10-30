import { sharedStore } from "../host/gone";
import type { HostCtx } from "../host/registry";
import type { VolumeStore } from "./store";

interface Activity {
  snapshots: number;
  removing: boolean;
}

// The store belongs to one control plane. Engine names are unique only within a host.
const activity = new WeakMap<VolumeStore, Map<string, Activity>>();

/**
 * Reserves a volume before any asynchronous read or removal. Snapshot readers may overlap; removal excludes every
 * reader until the engine has answered. Holding this across the backup also protects the gaps between its helpers.
 */
function reserve(host: HostCtx, engineName: string, removing: boolean): (() => void) | null {
  const store = sharedStore(host.volumes);
  let volumes = activity.get(store);
  if (!volumes) {
    volumes = new Map();
    activity.set(store, volumes);
  }
  const key = `${host.host.id}\0${engineName}`;
  const state = volumes.get(key) ?? { snapshots: 0, removing: false };
  if (state.removing || (removing && state.snapshots > 0)) return null;
  if (removing) state.removing = true;
  else state.snapshots += 1;
  volumes.set(key, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (removing) state.removing = false;
    else state.snapshots -= 1;
    if (!state.removing && state.snapshots === 0) volumes.delete(key);
  };
}

export const reserveVolumeSnapshot = (host: HostCtx, engineName: string): (() => void) | null =>
  reserve(host, engineName, false);

export const reserveVolumeRemoval = (host: HostCtx, engineName: string): (() => void) | null =>
  reserve(host, engineName, true);

export function volumeSnapshotting(host: HostCtx, engineName: string): boolean {
  return (activity.get(sharedStore(host.volumes))?.get(`${host.host.id}\0${engineName}`)?.snapshots ?? 0) > 0;
}
