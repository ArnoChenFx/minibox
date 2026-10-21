export interface Mount {
  volume: string;
  path: string;
  mode: "rw" | "ro";
}

export interface VolumeLike {
  id: string;
  name: string;
  ownership: "owned" | "independent";
  ownerBoxId: string | null;
  rwMounts: number;
}

export interface VolumeChoice {
  id: string;
  name: string;
  rwMounts: number;
  disabled: boolean;
}

export type MountProblem = { code: "volume" } | { code: "mount_path_invalid" | "mount_duplicate"; path: string };

export declare const MOUNT_MAX: number;
export declare const DEFAULT_MOUNTS: readonly { role: string; path: string; mode: "rw" | "ro" }[];

export declare function validMountPath(path: string): boolean;
export declare function canonicalMounts(mounts: readonly Partial<Mount>[] | null | undefined): string;
export declare function isVolumeErrorKey(key: unknown): boolean;
export declare function volumeChoices(volumes: readonly VolumeLike[], liveBoxIds: ReadonlySet<string>): VolumeChoice[];
export declare function checkMountRows(rows: readonly Mount[]): { mounts: Mount[] } | { problem: MountProblem };
