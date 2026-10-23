import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import type { TemplateInit } from "../services/template-builds";
import type { BoxMount } from "../specs/types";
import { findSharedTools, leftoverWorkspace } from "../volumes/engine";
import { poolForRole } from "../volumes/pools";
import { AuthorizationDenied } from "./executor";
import type { OperationContext, VolumeResource } from "./types";

/** A volume a check names: its record when it has one, otherwise only the name the request used. */
export interface VolumeRef {
  readonly id?: string;
  readonly name: string;
}

const resourceOf = (volume: VolumeRef): VolumeResource =>
  volume.id === undefined
    ? { kind: "volume", name: volume.name }
    : { kind: "volume", id: volume.id, name: volume.name };

/** Asks the authorize hook about one scope. Outside the executor, where no hook is attached, only the owner passes. */
async function allowed(ctx: OperationContext, scope: string, volume?: VolumeRef): Promise<boolean> {
  if (!ctx.authorize) return ctx.principal.type === "owner";
  return ctx.authorize({ scope, resource: volume ? resourceOf(volume) : undefined });
}

/**
 * Mounting a volume is a read of that volume. The hook decides from the volume's record, so a token passes only when
 * its grant covers that volume. A refusal is `volume_attach_forbidden`.
 */
export async function assertCanAttach(ctx: OperationContext, volume: VolumeRef): Promise<void> {
  if (await allowed(ctx, "volume:attach", volume)) return;
  throw new AuthorizationDenied(
    new AppError(403, "forbidden", msg("volume_attach_forbidden", { volume: volume.name })),
  );
}

/**
 * A read-write mount writes to the volume, and so does creating one. Without a volume, the check covers the volumes a
 * new box creates for itself.
 */
export async function assertCanWrite(ctx: OperationContext, volume?: VolumeRef): Promise<void> {
  if (await allowed(ctx, "volume:write", volume)) return;
  const error = volume
    ? new AppError(403, "forbidden", msg("volume_write_forbidden", { volume: volume.name }))
    : new AppError(403, "forbidden", msg("volume_create_forbidden"));
  throw new AuthorizationDenied(error);
}

/** A delete that skips the recycle bin keeps no copy, so a token needs `trash:skip` to ask for one. The owner always may. */
export async function assertCanSkipTrash(ctx: OperationContext): Promise<void> {
  if (await allowed(ctx, "trash:skip")) return;
  throw new AuthorizationDenied(new AppError(403, "forbidden", msg("trash_skip_forbidden")));
}

/**
 * Whether the caller may delete one volume. A batch or a prune asks per volume, so a refusal for one volume leaves the
 * others to be judged on their own.
 */
export function canDeleteVolume(ctx: OperationContext, volume: VolumeRef): Promise<boolean> {
  return allowed(ctx, "volume:delete", volume);
}

/** Replacing storage pools changes where every new volume goes, so only an administrator may do it. */
export async function assertCanAdministerPools(ctx: OperationContext): Promise<void> {
  if (await allowed(ctx, "pool:admin")) return;
  throw new AuthorizationDenied(new AppError(403, "forbidden", msg("pool_admin_forbidden")));
}

/**
 * A custom entry becomes the install, upgrade and detect command of every later install, and its raw text is only
 * visible to the owner. So only the owner may list, save or delete one, whatever token it holds.
 */
export async function assertCanAdministerCatalog(ctx: OperationContext): Promise<void> {
  if (await allowed(ctx, "tool:custom")) return;
  throw new AuthorizationDenied(new AppError(403, "forbidden", msg("tool_custom_forbidden")));
}

/**
 * A declared template's setup runs a command in the new box and opens its ports, so a box made from it needs what those
 * need: `exec` for the postCreateCommand and `port:expose` for the forwarded ports. The owner always passes.
 */
export async function assertTemplateSetupAllowed(ctx: OperationContext, setup: TemplateInit | null): Promise<void> {
  if (setup?.postCreate !== undefined && !(await allowed(ctx, "exec"))) {
    throw new AuthorizationDenied(new AppError(403, "forbidden", msg("template_command_forbidden")));
  }
  if (setup?.forwardPorts?.length && !(await allowed(ctx, "port:expose"))) {
    throw new AuthorizationDenied(new AppError(403, "forbidden", msg("template_ports_forbidden")));
  }
}

/**
 * Checks the mounts a create, update or rebuild asks for. A mount the box already has, with the same volume, path and
 * mode, is kept and is not checked again. Any other mount needs `volume:attach` on its volume, and a read-write one
 * also needs `volume:write`. A name with no record is a volume to create, so it needs `volume:write` either way.
 */
export async function assertCanChangeMounts(
  ctx: OperationContext,
  requested: readonly BoxMount[],
  current: readonly BoxMount[],
): Promise<void> {
  for (const mount of requested) {
    const record = ctx.host.volumes.resolve(mount.volume, ctx.host.host.id);
    const engineName = record?.engineName ?? mount.volume;
    const kept = current.some(
      (item) => item.volume === engineName && item.path === mount.path && item.mode === mount.mode,
    );
    if (kept) continue;
    const volume: VolumeRef = record ?? { name: mount.volume };
    await assertCanAttach(ctx, volume);
    if (!record || mount.mode === "rw") await assertCanWrite(ctx, volume);
  }
}

/**
 * A new box creates its own read-write workspace, home and cache volumes, so it needs `volume:write`. A leftover
 * `prefix-ws-<name>` volume that the box would adopt as its workspace is an existing volume mounted read-write, so it
 * gets the checks of any such mount. The shared tools volume is mounted read-only and needs `volume:attach`.
 */
export async function assertCanCreateDefaultMounts(ctx: OperationContext, boxName: string): Promise<void> {
  const leftover = await leftoverWorkspace(ctx.host, boxName);
  if (leftover) {
    const volume: VolumeRef = leftover.record ?? { name: leftover.engineName };
    await assertCanAttach(ctx, volume);
    await assertCanWrite(ctx, volume);
  }
  const tools = findSharedTools(ctx.host, poolForRole(ctx.host.volumes.readPools(), "tools").name);
  if (tools) await assertCanAttach(ctx, tools);
  await assertCanWrite(ctx);
}
