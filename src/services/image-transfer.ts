import { Readable } from "node:stream";

import type { HostCtx } from "../host/registry";
import { AppError, conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import { type ByteProgress, countingChunks } from "../lib/transfer";
import { type ImageDetails, isRuntimeError } from "../runtime";

/**
 * True when `host` must load the image. Loading an archive moves every tag it carries, so each tag the image has on the
 * source is checked. A tag the host holds for a different image is refused rather than moved away from it.
 */
export async function needsImage(host: HostCtx, ref: string, image: ImageDetails): Promise<boolean> {
  let transfer = false;
  for (const tag of new Set([ref, ...image.tags])) {
    let held: ImageDetails;
    try {
      held = await host.runtime.inspectImage(tag);
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) throw e;
      transfer = true;
      continue;
    }
    if (held.id !== image.id) throw conflict(msg("move_template_differs", { host: host.host.id, tag }));
  }
  return transfer;
}

/**
 * Sends the image `ref` from `from` to `to`, and loads it there under the id it has on the source, so a box's digest
 * holds on the target. The archive is streamed, so no copy is kept on the control plane. A load that lands another id
 * fails, and the caller's `signal` stops the transfer. `onBytes` reports the bytes sent so far.
 */
export async function sendImage(
  from: HostCtx,
  to: HostCtx,
  ref: string,
  expectedId: string,
  signal: AbortSignal | undefined,
  onBytes?: ByteProgress,
): Promise<void> {
  const archive = await from.runtime.saveImage(ref);
  const stop = () => archive.destroy();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await to.runtime.loadImage(
      onBytes ? Readable.from(countingChunks(archive, onBytes), { objectMode: false }) : archive,
    );
  } finally {
    signal?.removeEventListener("abort", stop);
    archive.destroy();
  }
  const landed = await to.runtime.inspectImage(ref);
  if (landed.id !== expectedId) {
    throw new AppError(
      502,
      "docker_error",
      msg("docker_error", { detail: `image ${ref} loaded as ${landed.id}, not ${expectedId}` }),
    );
  }
}
