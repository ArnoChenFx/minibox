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
  hostId?: string | null;
  role?: string | null;
  ownership: "owned" | "independent";
  ownerBoxId: string | null;
  rwMounts: number;
}

export interface VolumeChoice {
  id: string;
  name: string;
  /** The host whose engine holds the volume. A create predicts the shared tools volume of its own host. */
  hostId: string | null;
  role: string | null;
  /** Only an independent tools volume is a host's shared tools volume, as `isSharedTools` has it. */
  ownership: "owned" | "independent";
  rwMounts: number;
  disabled: boolean;
}

/** One option of a create row's volume select: a role to create, or a volume that exists. */
export interface CreateMountChoice {
  value: string;
  role: string | null;
  /** True for the tools role when the host already has a shared tools volume, which it mounts. */
  shared: boolean;
  /** True for the tools role when the host has none, so the create makes the shared volume. */
  noShared: boolean;
  /** The name `roleVolumeNames` predicted for this role, or null when the dialog has no prediction. */
  preview: RoleVolumeName | null;
  volume?: VolumeChoice;
}

/**
 * The name MiniBox would give one role volume of the box being created, as the dialog previews it. `exact` is false when
 * the host already uses that name, so the server's `freeName` adds a suffix the dialog cannot know. `hostKnown` is false
 * for automatic placement: the host, and so the shared tools volume's name, is decided inside the create.
 */
export interface RoleVolumeName {
  name: string | null;
  /** True when the volume is there already: the shared tools volume of the host the box goes to. */
  exists: boolean;
  exact: boolean;
  hostKnown: boolean;
}

export interface RoleNameInput {
  boxName: string;
  hostId: string;
  labelPrefix: string;
  /** The host's shared tools volume, when the dialog already knows the host and the host has one. */
  sharedTools?: { name: string } | null;
  /** Display names the host already uses, which the server has to avoid. */
  taken?: readonly string[];
  /** False when the create picks the host itself (`auto`), so the shared tools volume has no name yet. */
  hostKnown?: boolean;
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
export declare function createMountChoices(
  volumes: readonly VolumeChoice[],
  sharedTools: boolean,
  preview?: Partial<Record<string, RoleVolumeName>> | null,
): CreateMountChoice[];
export declare function validMountPath(path: string): boolean;
export declare function canonicalMounts(mounts: readonly Partial<Mount>[] | null | undefined): string;
export declare function isVolumeErrorKey(key: unknown): boolean;
export declare function volumeChoices(volumes: readonly VolumeLike[], liveBoxIds: ReadonlySet<string>): VolumeChoice[];
export declare function sharedToolsChoice(choices: readonly VolumeChoice[]): VolumeChoice | null;
/** The names the volumes of one host already use. */
export declare function namesOnHost(choices: readonly VolumeChoice[], hostId: string): string[];
/** The host's shared tools volume: its independent tools volume, or null when it has none. */
export declare function sharedToolsOnHost(choices: readonly VolumeChoice[], hostId: string): VolumeChoice | null;
/** The names MiniBox would give this box's role volumes. Mirrors `defaultRolePlans` in src/volumes/engine.ts. */
export declare function roleVolumeNames(input: RoleNameInput): Record<string, RoleVolumeName>;
/** The predictions of the roles a mount list still names, in row order. */
export declare function previewRoleNames(
  rows: readonly { volume: string }[],
  names: Readonly<Record<string, RoleVolumeName>> | null | undefined,
): (RoleVolumeName & { role: string })[];
/**
 * The lines the Volumes section says under its rows, as i18n keys and their parameters: `cb.previewCreate`,
 * `cb.previewCreateInexact`, `cb.previewShared`, `cb.previewUnnamed` or `cb.previewHostUnknown`.
 */
export declare function previewNoteLines(
  rows: readonly { volume: string }[],
  names: Readonly<Record<string, RoleVolumeName>> | null | undefined,
): { key: string; params: Record<string, string> }[];
/** A row of a create's mount list: a volume it mounts, or the role whose volume it has MiniBox create. */
export interface MountRow {
  volume: string;
  path: string;
  mode: "rw" | "ro";
}

export declare function checkMountRows(
  rows: readonly MountRow[],
): { mounts: CreateMount[] } | { problem: MountProblem };
