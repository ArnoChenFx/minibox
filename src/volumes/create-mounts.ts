import type { MountMode } from "../specs/types";
import { ROLE_MOUNT, type VolumeRole, VOLUME_ROLES } from "./types";

/**
 * One mount a create asks for. It names either a recorded volume (`volume`, with `path` and `mode`), as a create always
 * could, or a role whose volume MiniBox creates for this box (`role`). A role mount takes the role's own path and mode
 * unless the request repeats them, which it may only do with the values the role fixes.
 */
export type CreateMount =
  | { volume: string; path: string; mode: MountMode }
  | { role: VolumeRole; path?: string; mode?: MountMode };

/** Whether a create mount names a role volume to create rather than a recorded volume to attach. */
export function isRoleMount(mount: CreateMount): mount is { role: VolumeRole; path?: string; mode?: MountMode } {
  return "role" in mount;
}

/** The path and mode a create mount takes: the ones it sends, or the role's own. */
export function mountPointOf(mount: CreateMount): { path: string; mode: MountMode } {
  if (!isRoleMount(mount)) return { path: mount.path, mode: mount.mode };
  const fixed = ROLE_MOUNT[mount.role];
  return { path: mount.path ?? fixed.path, mode: mount.mode ?? fixed.mode };
}

/** The roles a create mount list would create a volume for, in the order it lists them. */
export function rolesToCreate(mounts: readonly CreateMount[]): VolumeRole[] {
  return mounts.filter(isRoleMount).map((mount) => mount.role);
}

/** The roles that mount a volume read-write, so a create hands a new one to the box user. */
export function writableRoleMounts(mounts: readonly CreateMount[]): { role: VolumeRole; path: string }[] {
  return mounts
    .filter(isRoleMount)
    .map((mount) => ({ role: mount.role, ...mountPointOf(mount) }))
    .filter((mount) => mount.mode === "rw");
}

/** True for a role name the volume model knows. */
export function isVolumeRole(value: unknown): value is VolumeRole {
  return typeof value === "string" && (VOLUME_ROLES as readonly string[]).includes(value);
}
