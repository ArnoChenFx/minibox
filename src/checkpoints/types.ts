import type { BoxProfile } from "../box-profile";
import type { BoxSpec } from "../specs/types";
import type { VolumeRole } from "../volumes/types";

/** On-disk schema version of `DATA_DIR/checkpoints/<id>.json`. */
export const CHECKPOINT_VERSION = 1;

/** `live` is crash-consistent; `pause` freezes the box's processes for the backup; `stop` stops the box for it. */
export const CONSISTENCY_MODES = ["live", "pause", "stop"] as const;
export type Consistency = (typeof CONSISTENCY_MODES)[number];

/** One volume's content, as a snapshot in the checkpoint repository. */
export interface DataLayer {
  /** Stable id (`vol_…`) of the volume the layer was taken from. */
  volumeId: string;
  /** Where the volume was mounted in the box when the checkpoint was taken. */
  path: string;
  role: VolumeRole | null;
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

/** What a new box needs to start from the checkpoint: the spec fields that a create call accepts. */
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
  /** Source box id (`bx_…`). The box may be renamed or deleted later; the checkpoint keeps the id. */
  boxId: string;
  /** Box name when the checkpoint was taken. Display only. */
  boxName: string;
  label: string;
  reason: string;
  /** Principal that took the checkpoint. Null when none was recorded. */
  createdBy: string | null;
  pinned: boolean;
  /** Set by automatic triggers (rollback and rebuild safety points). Manual checkpoints are never automatic. */
  auto: boolean;
  consistency: Consistency;
  /** The box's spec revision when the checkpoint was taken. */
  specRevision: number;
  spec: CheckpointSpec;
  data: DataLayer[];
  system: SystemLayer | null;
  createdAt: string;
  updatedAt: string;
}
