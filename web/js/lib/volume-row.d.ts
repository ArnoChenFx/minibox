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

/** A volume, narrowed to the host it lives on. */
export interface HostedVolume {
  hostId: string;
}

/** A host, as `GET /api/hosts` lists it. Only the fields this decision reads are named. */
export interface VolumeRowHost {
  id: string;
  transport?: string;
}

/**
 * Why a volume on an agent host cannot be browsed, measured or snapshotted: the i18n key of the reason, or "" when it
 * can. A host the list does not name yet is not called an agent, so a page that opens before the host list loads keeps
 * every button.
 */
export declare const agentVolumeBlock: (volume: HostedVolume, hosts: readonly VolumeRowHost[]) => string;

export interface StagedEntry {
  box: { boxId: string; name: string };
  staged: { fields?: { mounts?: readonly { volume: string }[] } } | null | undefined;
}

export declare function stagedMountsByVolume(
  entries: readonly StagedEntry[],
  volumes: readonly { id: string; name?: string; engineName?: string; mounts: readonly { boxId: string }[] }[],
): Map<string, string[]>;
