import type { MountMode } from "../specs/types";
import { ROLE_MOUNT, type VolumeRole, VOLUME_ROLES } from "./types";

/**
 * One mount a create asks for. It names either a recorded volume (`volume`, with `path` and `mode`), as a create always
 * could, or a role whose volume MiniBox creates for this box (`role`). A role mount takes the role's own path and mode
 * unless the request repeats them, which it may only do with the values the role fixes. `pool` names the storage pool
 * the role's new volume goes to, instead of the pool the role's rule picks.
 */
export type CreateMount =
  | { volume: string; path: string; mode: MountMode }
  | { role: VolumeRole; path?: string; mode?: MountMode; pool?: string };

/** A role volume a create asks MiniBox to make, and the pool the request picked for it when it picked one. */
export interface RoleRequest {
  role: VolumeRole;
  pool?: string;
}

/** Whether a create mount names a role volume to create rather than a recorded volume to attach. */
export function isRoleMount(
  mount: CreateMount,
): mount is { role: VolumeRole; path?: string; mode?: MountMode; pool?: string } {
  return "role" in mount;
}

/** The path and mode a create mount takes: the ones it sends, or the role's own. */
export function mountPointOf(mount: CreateMount): { path: string; mode: MountMode } {
  if (!isRoleMount(mount)) return { path: mount.path, mode: mount.mode };
  const fixed = ROLE_MOUNT[mount.role];
  return { path: mount.path ?? fixed.path, mode: mount.mode ?? fixed.mode };
}

/** The role volumes a create mount list asks for, in the order it lists them, each with the pool it picked. */
export function roleRequests(mounts: readonly CreateMount[]): RoleRequest[] {
  return mounts
    .filter(isRoleMount)
    .map((mount) => (mount.pool ? { role: mount.role, pool: mount.pool } : { role: mount.role }));
}

/** The pool each role volume goes to when the request picks one. A role the request leaves out follows its rule. */
export function rolePoolsOf(requests: readonly RoleRequest[]): Map<VolumeRole, string> {
  const pools = new Map<VolumeRole, string>();
  for (const request of requests) if (request.pool) pools.set(request.role, request.pool);
  return pools;
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
