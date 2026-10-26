export interface Mount {
  volume: string;
  path: string;
  mode: "rw" | "ro";
}

/** A mount a create sends: a recorded volume, or a role whose volume MiniBox creates for the box. */
export type CreateMount = { volume: string; path: string; mode: "rw" | "ro" } | { role: string };

export interface VolumeLike {
  id: string;
  name: string;
  role?: string | null;
  ownership: "owned" | "independent";
  ownerBoxId: string | null;
  rwMounts: number;
}

export interface VolumeChoice {
  id: string;
  name: string;
  role: string | null;
  rwMounts: number;
  disabled: boolean;
}

/** One option of a create row's volume select: a role to create, or a volume that exists. */
export interface CreateMountChoice {
  value: string;
  role: string | null;
  shared: boolean;
  volume?: VolumeChoice;
}

export type MountProblem =
  | { code: "volume" }
  | { code: "mount_path_invalid" | "mount_duplicate"; path: string }
  | { code: "mount_create_role_duplicate"; role: string }
  | { code: "mount_create_role_path"; role: string; path: string; expected: string };

export declare const MOUNT_MAX: number;
export declare const ROLE_PREFIX: string;
export declare const DEFAULT_MOUNTS: readonly { role: string; path: string; mode: "rw" | "ro" }[];

export declare function roleOfValue(value: string | null | undefined): string | null;
export declare function roleValue(role: string): string;
export declare function roleMount(role: string): { role: string; path: string; mode: "rw" | "ro" } | null;
export declare function createMountChoices(volumes: readonly VolumeChoice[], sharedTools: boolean): CreateMountChoice[];
export declare function validMountPath(path: string): boolean;
export declare function canonicalMounts(mounts: readonly Partial<Mount>[] | null | undefined): string;
export declare function isVolumeErrorKey(key: unknown): boolean;
export declare function volumeChoices(volumes: readonly VolumeLike[], liveBoxIds: ReadonlySet<string>): VolumeChoice[];
export declare function sharedToolsChoice(choices: readonly VolumeChoice[]): VolumeChoice | null;
export declare function checkMountRows(rows: readonly Mount[]): { mounts: CreateMount[] } | { problem: MountProblem };
