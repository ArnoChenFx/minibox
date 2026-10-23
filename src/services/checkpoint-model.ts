import type { BoxProfile } from "../box-profile";
import type { Consistency, CheckpointSpec, DataLayer, SystemLayer } from "../checkpoints/types";
import type { ContainerChange } from "../runtime";
import { REBUILD_LOSES } from "../specs/plan";
import type { VolumeRole } from "../volumes/types";
import type { Box } from "./boxes";

/** Progress lines and cancellation for a call that may run for a while. A task handle satisfies it. */
export interface Progress {
  readonly signal?: AbortSignal;
  log?(text: string): void;
}

/**
 * A checkpoint as the API shows it. A snapshot made before checkpoints appears too, with only a system layer and an id
 * derived from its image, so one listing covers both.
 */
export interface CheckpointView {
  id: string;
  legacy: boolean;
  hostId: string;
  boxId: string | null;
  boxName: string | null;
  label: string;
  reason: string;
  createdBy: string | null;
  pinned: boolean;
  auto: boolean;
  consistency: Consistency;
  specRevision: number | null;
  spec: CheckpointSpec;
  data: DataLayer[];
  system: SystemLayer | null;
  /** Bytes restic read from the volumes, summed over the data layers. */
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface TakeCheckpointInput {
  label?: string;
  reason?: string;
  pinned: boolean;
  /** Volumes to include beyond the default set, and whether to commit the writable layer. */
  include: { system: boolean; volumes: string[] };
  consistency: Consistency;
}

export interface ForkCheckpointInput {
  name: string;
  cpus: number;
  memoryMb: number;
  profile?: BoxProfile;
  copyHome: boolean;
  ttlSec?: number | null;
}

export interface CheckpointPatch {
  pinned?: boolean;
  label?: string;
}

export const ROLLBACK_KEEPS = ["id", "name", "history", "shared volumes"] as const;

/** What a rollback would do, shown before anything changes. Its `restores` are the current volumes it replaces. */
export interface RollbackPreview {
  checkpoint: { id: string; label: string; createdAt: string };
  restores: { path: string; role: VolumeRole | null; volume: string }[];
  keeps: typeof ROLLBACK_KEEPS;
  loses: typeof REBUILD_LOSES;
  diff: ContainerChange[];
  revision: { current: number; next: number };
}

export interface RollbackResult {
  box: Box;
  /**
   * The volumes the rollback replaced. They are kept, unmounted and still owned by the box, until the rollback is
   * confirmed or undone.
   */
  replaced: { id: string; name: string }[];
  /** The automatic checkpoint taken first. It holds the data the replaced volumes held. */
  safety: { id: string; label: string };
}
