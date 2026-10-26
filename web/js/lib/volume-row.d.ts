export interface CheckpointLayerRef {
  volumeId: string;
}

export interface CheckpointRef {
  createdAt: string;
  data: readonly CheckpointLayerRef[];
}

export interface SnapshotVolume {
  id: string;
  role: string | null;
  checkpoint: boolean;
  ownership: string;
  ownerBoxId: string | null;
  ownerMissing?: boolean;
  mounts: readonly { boxId: string; boxName: string }[];
}

export interface SnapshotPlan {
  block: string;
  /** True when the volume is snapshotted on its own, as a checkpoint that names no box. */
  own?: boolean;
  boxId?: string | null;
  boxName?: string | null;
  include?: string[];
}

export declare function latestByVolume<T extends CheckpointRef>(checkpoints: readonly T[]): Map<string, T>;

export declare function snapshotPlan(volume: SnapshotVolume): SnapshotPlan;

export interface StagedEntry {
  box: { boxId: string; name: string };
  staged: { fields?: { mounts?: readonly { volume: string }[] } } | null | undefined;
}

export declare function stagedMountsByVolume(
  entries: readonly StagedEntry[],
  volumes: readonly { id: string; name?: string; engineName?: string; mounts: readonly { boxId: string }[] }[],
): Map<string, string[]>;
