import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import type { VolumeRecord } from "../volumes/types";
import { AuthorizationDenied } from "./executor";
import type { OperationContext } from "./types";

/**
 * Mounting a volume is a read of that volume. The owner is allowed. A hook that returns false for
 * `volume:attach` refuses the mount. Agent tokens will carry this scope when #13 lands; until then the
 * default hook allows every owner.
 */
export async function assertCanAttach(ctx: OperationContext, volume: Pick<VolumeRecord, "id" | "name">): Promise<void> {
  const allowed = ctx.authorize
    ? await ctx.authorize({ scope: "volume:attach", resource: { kind: "volume", id: volume.id, name: volume.name } })
    : ctx.principal.type === "owner";
  if (!allowed) {
    throw new AuthorizationDenied(
      new AppError(403, "forbidden", msg("volume_attach_forbidden", { volume: volume.name })),
    );
  }
}
