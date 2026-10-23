import type { HostCtx } from "../host/registry";
import { AppError, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { pushHistory } from "../specs/history";
import { DEV_GID, DEV_UID, fileArchive } from "./files-tar";
import { beginChange } from "./moving";

/** The directory the token file lives in, inside the box. */
export const SELF_TOKEN_DIR = "/run/minibox";
const SELF_TOKEN_NAME = "self-token";

/**
 * The tmpfs the directory is mounted on. The token is written after each start and is gone when the container stops, so it
 * never reaches the container's writable layer, a `docker commit`, or an image. The directory belongs to the box's dev user.
 */
export function selfTokenTmpfs(): Record<string, string> {
  return { [SELF_TOKEN_DIR]: `rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=${DEV_UID},gid=${DEV_GID}` };
}

/** A host reached through a paired agent cannot receive a file, so a box on it cannot carry a self token. */
export function assertSelfTokenHost(host: HostCtx): void {
  if (host.host.transport === "agent") throw new AppError(501, "unsupported", msg("self_token_host_unsupported"));
}

/**
 * Issues the box's token and writes it into its running container. A token is issued on every start, so the file always
 * holds the token the store knows. A failed write revokes the token it issued, and the error goes to the caller.
 */
export async function provisionSelfToken(
  host: HostCtx,
  box: { readonly boxId: string; readonly name: string },
  containerId: string,
): Promise<void> {
  const secret = host.selfTokens.issue(box.boxId, box.name);
  const file = fileArchive(SELF_TOKEN_NAME, Buffer.from(`${secret}\n`), { mode: 0o600 });
  try {
    await host.runtime.putArchive(containerId, SELF_TOKEN_DIR, file);
  } catch (e) {
    host.selfTokens.revoke(box.boxId);
    throw e;
  }
}

/** Writes a fresh token into a box's container when its spec asks for one. A box without `selfToken` gets nothing. */
export async function deliverSelfToken(host: HostCtx, boxId: string, containerId: string): Promise<void> {
  const spec = host.specs.read(boxId);
  if (!spec?.selfToken) return;
  await provisionSelfToken(host, { boxId, name: spec.name }, containerId);
}

/**
 * Ends the box's token and turns the feature off in its spec, so no token is issued again until the box is recreated with
 * one. The spec changes, so it takes a new revision as any other change to it does. The token in the running container
 * stops working at once, because the store no longer knows it.
 */
export async function revokeSelfToken(host: HostCtx, boxId: string): Promise<void> {
  const release = beginChange(boxId);
  try {
    await host.specs.exclusive(async () => {
      const spec = host.specs.read(boxId);
      if (!spec) throw notFound(msg("box_not_found"));
      host.selfTokens.revoke(boxId);
      if (!spec.selfToken) return;
      host.specs.write({
        ...spec,
        selfToken: undefined,
        revision: spec.revision + 1,
        updatedAt: new Date().toISOString(),
        history: pushHistory(spec),
      });
    });
  } finally {
    release();
  }
}
