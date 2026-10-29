import type { AuditNote } from "../events/types";
import type { HostCtx } from "../host/registry";
import { templateOwnerOf } from "../labels";
import { toAppError } from "../lib/errors";
import type { VolumeOwner } from "../runtime";
import type { BoxMount } from "../specs/types";

/** Where a box mounts its workspace volume. The template decides the owner of that volume's root. */
const WORKSPACE = "/workspace";

/** Records an audit note for the operation that makes the change. Absent when nothing records, as in a test. */
export type RecordNote = (note: AuditNote) => void;

/** The volume a box mounts writable at `/workspace`, or null when it mounts none. */
export function writableWorkspaceVolume(mounts: readonly BoxMount[]): string | null {
  return mounts.find((mount) => mount.path === WORKSPACE && mount.mode !== "ro")?.volume ?? null;
}

export interface WorkspaceRoot {
  /** A container that mounts the volume at `/workspace`. It may be created and not running. */
  containerId: string;
  volume: string;
  /** The image the chown helper runs from. */
  image: string;
  /** Labels of the image the container was created from. They name the owner the template gives `/workspace`. */
  labels: Record<string, string>;
}

/**
 * Sets the root of a workspace volume to the owner its template names, when the root has another owner. A template that
 * names no owner reads nothing from the engine. Returns the owner the root had before the change, or null when the root
 * was left alone. A failed change is recorded and rethrown.
 */
export async function alignVolumeRoot(
  host: HostCtx,
  root: WorkspaceRoot,
  record?: RecordNote,
): Promise<VolumeOwner | null> {
  const wanted = templateOwnerOf(root.labels);
  if (!wanted) return null;
  const current = await host.runtime.volumeRootOwner(root.containerId, WORKSPACE);
  if (sameOwner(current, wanted)) return null;
  await setRootOwner(
    host,
    {
      op: "volume.chown",
      volume: root.volume,
      owner: wanted,
      image: root.image,
      detail: { from: ownerText(current), to: ownerText(wanted) },
      ok: `Volume owner set: ${root.volume}`,
      failed: `Volume owner change failed: ${root.volume}`,
    },
    record,
  );
  return current;
}

/**
 * Puts back the owner an alignment replaced, when the rebuild that made the change is rolled back. `image` is the image of
 * the old container, which still exists once the rollback has restored that container.
 */
export async function restoreVolumeRoot(
  host: HostCtx,
  restore: { volume: string; owner: VolumeOwner; image: string },
  record?: RecordNote,
): Promise<void> {
  await setRootOwner(
    host,
    {
      op: "volume.chown_undo",
      volume: restore.volume,
      owner: restore.owner,
      image: restore.image,
      detail: { to: ownerText(restore.owner) },
      ok: `Volume owner restored: ${restore.volume}`,
      failed: `Volume owner restore failed: ${restore.volume}`,
    },
    record,
  );
}

interface OwnerChange {
  op: "volume.chown" | "volume.chown_undo";
  volume: string;
  owner: VolumeOwner;
  image: string;
  detail: unknown;
  ok: string;
  failed: string;
}

async function setRootOwner(host: HostCtx, change: OwnerChange, record: RecordNote | undefined): Promise<void> {
  const target = { kind: "volume", name: change.volume };
  try {
    await host.runtime.setVolumeRootOwner(change.volume, change.owner, change.image);
  } catch (e) {
    const err = toAppError(e);
    record?.({
      op: change.op,
      kind: "write",
      status: "error",
      summary: change.failed,
      target,
      detail: change.detail,
      error: { code: err.code, status: err.status },
    });
    throw e;
  }
  record?.({ op: change.op, kind: "write", status: "ok", summary: change.ok, target, detail: change.detail });
}

const sameOwner = (a: VolumeOwner, b: VolumeOwner): boolean => a.uid === b.uid && a.gid === b.gid;
const ownerText = (owner: VolumeOwner): string => `${owner.uid}:${owner.gid}`;
