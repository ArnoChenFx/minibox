import type { HostCtx } from "../host/registry";
import { untilAborted } from "../lib/abort";
import { log } from "../lib/logger";
import { byteLog, type TransferProgress } from "../lib/transfer";
import { type ImageDetails, isRuntimeError } from "../runtime";
import { needsImage, sendImage } from "./image-transfer";
import { copyRecipe } from "./template-builds";

/** A host that holds a MiniBox template, and the image as that host's engine reports it. */
export interface TemplateSource {
  readonly host: HostCtx;
  readonly image: ImageDetails;
}

/**
 * The image `ref` on `host`, or null when the engine does not hold it. An engine that does not answer in time is taken
 * as not holding it, so one slow host cannot stall a create that does not need it.
 */
export async function heldImage(host: HostCtx, ref: string): Promise<ImageDetails | null> {
  try {
    return await untilAborted(host.runtime.inspectImage(ref), AbortSignal.timeout(host.readTimeoutMs));
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) {
      log.warn("template.inspect_failed", { host: host.host.id, ref, error: String(e) });
    }
    return null;
  }
}

/**
 * The first of `hosts` that holds `ref` as a MiniBox template, so a copy can start there. A host that is offline, an
 * agent, or holds only a registry image of that name is passed over. Null when no host qualifies.
 */
export async function findTemplateSource(hosts: readonly HostCtx[], ref: string): Promise<TemplateSource | null> {
  for (const host of hosts) {
    if (host.host.status === "offline" || host.host.transport === "agent") continue;
    const image = await heldImage(host, ref);
    if (image?.labels[host.keys.template] === "true") return { host, image };
  }
  return null;
}

/**
 * Copies the template from `source` to `target` unless the target already holds that image, and gives the target the
 * recipe that built it, so a declared template keeps its setup there. The move that carries a box uses the same transfer,
 * so a template copy and a box move agree on what a host may hold. Returns whether an image was sent. `progress` carries
 * the stop signal and the task log that the transfer writes its bytes to.
 */
export async function copyTemplate(
  source: TemplateSource,
  target: HostCtx,
  ref: string,
  progress?: TransferProgress,
): Promise<boolean> {
  const transfer = await needsImage(target, ref, source.image);
  if (transfer) {
    await sendImage(source.host, target, ref, source.image.id, progress?.signal, byteLog(progress, "Sent"));
  }
  copyRecipe(source.host, target, ref, source.image.id);
  return transfer;
}
