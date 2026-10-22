import type { BoxProfile } from "../box-profile";
import type { VolumeOwner } from "../runtime";
import type { BoxSpec, MountMode } from "../specs/types";
import type { VolumeOwnership, VolumeRole } from "../volumes/types";

/** On-disk schema version of `DATA_DIR/checkpoints/<id>.json`. */
export const CHECKPOINT_VERSION = 1;

/** `live` is crash-consistent; `pause` freezes the box's processes for the backup; `stop` stops the box for it. */
export const CONSISTENCY_MODES = ["live", "pause", "stop"] as const;
export type Consistency = (typeof CONSISTENCY_MODES)[number];

/** What a recycle bin entry holds: a deleted box's data, or a deleted volume's. */
export const TRASH_KINDS = ["box", "volume"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

/**
 * Set on a checkpoint that keeps a deleted box's or volume's data until `expiresAt`. Such a checkpoint is listed under the
 * recycle bin and never as a checkpoint, and retention removes it when it expires.
 */
export interface TrashMark {
  kind: TrashKind;
  /** The id the box (`bx_…`) or volume (`vol_…`) had when it was deleted. */
  sourceId: string;
  /** The name it had. A restore uses it as the new name unless another is given. */
  sourceName: string;
  deletedAt: string;
  expiresAt: string;
}

/** A recycle bin entry a delete left behind: its id, and when retention purges it. */
export interface TrashRef {
  id: string;
  expiresAt: string;
}

/** One volume's content, as a snapshot in the checkpoint repository. */
export interface DataLayer {
  /** Stable id (`vol_…`) of the volume the layer was taken from. */
  volumeId: string;
  /** Where the volume was mounted in the box when the checkpoint was taken. Empty for a volume kept on its own. */
  path: string;
  mode: MountMode;
  role: VolumeRole | null;
  ownership: VolumeOwnership;
  /**
   * Owner of the volume's root directory when the checkpoint was taken. A restore writes the files and their owners,
   * but not this directory, so the restore sets it from here.
   */
  owner: VolumeOwner;
  /** Restic snapshot id in the checkpoint repository. */
  snapshotId: string;
  /** Bytes restic read from the volume for this snapshot. */
  bytes: number;
}

/** The container's writable layer, committed as an image. */
export interface SystemLayer {
  image: string;
  imageId: string;
}

/**
 * What a new box needs to start from the checkpoint. Resources are null when the box had none recorded, as a box
 * claimed from an unlabeled container does not.
 */
export interface CheckpointSpec {
  template: BoxSpec["template"];
  cpus: number | null;
  memoryBytes: number | null;
  profile: BoxProfile | null;
}

export interface CheckpointRecord {
  version: typeof CHECKPOINT_VERSION;
  id: string;
  hostId: string;
  /**
   * Source box id (`bx_…`). The box may be renamed or deleted later; the checkpoint keeps the id. Null for a volume kept in
   * the recycle bin, which had no box.
   */
  boxId: string | null;
  /** Box name when the checkpoint was taken. Display only. */
  boxName: string | null;
  label: string;
  reason: string;
  /** Principal that took the checkpoint. Null when none was recorded. */
  createdBy: string | null;
  pinned: boolean;
  /** Set by automatic triggers (rollback and rebuild safety points). Manual checkpoints are never automatic. */
  auto: boolean;
  consistency: Consistency;
  /** The box's spec revision when the checkpoint was taken. Null for a volume kept in the recycle bin. */
  specRevision: number | null;
  spec: CheckpointSpec | null;
  data: DataLayer[];
  system: SystemLayer | null;
  /** Set on a recycle bin entry. Every other checkpoint has null here. */
  trash: TrashMark | null;
  createdAt: string;
  updatedAt: string;
}

/** On-disk schema version of `DATA_DIR/checkpoints/rollbacks/<box id>.json`. */
export const ROLLBACK_VERSION = 1;

/** One volume a rollback restored or replaced, and the path the box mounts it at. */
export interface RolledVolume {
  volumeId: string;
  name: string;
  engineName: string;
  path: string;
}

/**
 * A rollback whose replaced volumes are still kept. The box mounts the restored ones. The replaced ones wait until the
 * rollback is confirmed (they are deleted) or undone (the box mounts them again). A box has at most one.
 */
export interface PendingRollback {
  version: typeof ROLLBACK_VERSION;
  hostId: string;
  boxId: string;
  boxName: string;
  checkpointId: string;
  checkpointLabel: string;
  /** The checkpoint taken just before the rollback. It still holds the replaced data after a confirm. */
  safetyCheckpointId: string;
  createdBy: string | null;
  createdAt: string;
  replaced: RolledVolume[];
  restored: RolledVolume[];
}
