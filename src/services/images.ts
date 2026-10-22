import type { HostCtx } from "../host/registry";
import { envChange, parseImageLabels } from "../labels";
import { AppError, badRequest, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { type ImageDetails, type ImageSummary, isRuntimeError } from "../runtime";
import type { Box } from "./boxes";

const DIGEST_OR_ID_RE = /^(sha256:)?[0-9a-f]{12,64}$/;

/**
 * Whether a missing image may be fetched from a registry. MiniBox's own templates, snapshots and checkpoints exist only
 * on the engine that made them, and an image id names one image there, so neither is pulled.
 */
export function isPullable(host: HostCtx, ref: string): boolean {
  if (DIGEST_OR_ID_RE.test(ref)) return false;
  const repository = ref.replace(/@.*$/, "").replace(/:[^/:]*$/, "");
  const local = [`${host.prefix}-template`, `${host.prefix}-snap`, `${host.prefix}-checkpoint`];
  return !local.includes(repository);
}

/**
 * Fetches `ref` from its registry, logging each layer's progress through `log`, and returns the image id. A reference the
 * registry does not hold fails with `image_not_found`; any other failure with `image_pull_failed`, carrying the engine's text.
 */
export async function pullImageInto(
  host: HostCtx,
  ref: string,
  opts: { log?(text: string): void; field: "ref" | "template" },
): Promise<string> {
  try {
    await host.runtime.pullImage(ref, { onLog: (text) => opts.log?.(text) });
  } catch (e) {
    if (isRuntimeError(e, "not_found")) throw badRequest(msg("image_not_found", { image: ref }), { field: opts.field });
    const detail = (e instanceof Error ? e.message : String(e)).trim().slice(0, 400);
    throw badRequest(msg("image_pull_failed", { image: ref, detail }), { field: opts.field });
  }
  return (await host.runtime.inspectImage(ref)).id;
}

/**
 * Refuses an image that is missing and cannot be pulled. A missing one that a registry may hold passes, and nothing is
 * fetched: the pull happens when the image is used.
 */
export async function assertImageAvailable(host: HostCtx, ref: string): Promise<void> {
  try {
    await host.runtime.inspectImage(ref);
    return;
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) throw e;
  }
  if (!isPullable(host, ref)) throw missingTemplate(ref);
}

function missingTemplate(ref: string): AppError {
  return badRequest(msg("template_image_missing", { image: ref }), { field: "template" });
}

/**
 * The image `ref` names on this engine. A missing one that a registry may hold is pulled first, so a box or a rebuild
 * can start from an image that was never built here. A missing MiniBox image, or one the registry does not hold, is
 * refused as a missing template.
 */
export async function ensureImageOn(
  host: HostCtx,
  ref: string,
  progress?: { log?(text: string): void },
): Promise<ImageDetails> {
  try {
    return await host.runtime.inspectImage(ref);
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) throw e;
  }
  if (!isPullable(host, ref)) throw missingTemplate(ref);
  progress?.log?.(`Pulling ${ref}…\n`);
  try {
    await pullImageInto(host, ref, { log: progress?.log, field: "template" });
  } catch (e) {
    if (e instanceof AppError && e.key === "image_not_found") throw missingTemplate(ref);
    throw e;
  }
  return host.runtime.inspectImage(ref);
}

export interface ImageItem {
  id: string;
  ref: string;
  tags: string[];
  name: string;
  description: string | null;
  source: string | null;
  /** Stable id of the box a snapshot was taken from. Null for images that have none. */
  sourceId: string | null;
  /** Principal id that created the image. Null for images built by the owner's own tooling. */
  createdBy: string | null;
  createdAt: string;
  size: number;
}

export function toImageItem(host: HostCtx, img: ImageSummary): ImageItem {
  const labels = parseImageLabels(img.labels, host.keys);
  const tags = img.repoTags.filter((t) => t !== "<none>:<none>");
  const ref = tags[0] ?? img.id;
  return {
    id: img.id,
    ref,
    tags,
    name: labels.templateName ?? ref.split(":").pop() ?? ref,
    description: labels.description,
    source: labels.snapshotOf,
    sourceId: labels.sourceId,
    createdBy: labels.createdBy,
    createdAt: labels.created ?? img.createdAt,
    size: img.size,
  };
}

export async function listImagesByLabel(host: HostCtx, label: string): Promise<ImageItem[]> {
  const images = await host.runtime.listImages({ labels: { [label]: "true" } });
  return images.map((i) => toImageItem(host, i)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * `ENV` instructions for a commit of `box`, so that no value the box was given reaches an image made from it. `docker
 * commit` copies the container's environment into the image, and every box made from that image would see the value. A
 * name the image sets goes back to the image's own value. Any other name goes to empty, since an instruction cannot
 * remove a variable. The same happens when the image's value holds a control character, which an instruction cannot.
 */
export async function envScrubChanges(host: HostCtx, box: Box): Promise<string[]> {
  // Every entry, a secretRef one too: once a secret is injected, its value sits in the container's environment as well.
  const given = box.env.map((entry) => entry.name);
  if (given.length === 0) return [];
  const { imageId } = await host.runtime.inspectContainer(box.id);
  const own = new Map<string, string>();
  for (const entry of (await host.runtime.inspectImage(imageId)).env) {
    const eq = entry.indexOf("=");
    own.set(eq < 0 ? entry : entry.slice(0, eq), eq < 0 ? "" : entry.slice(eq + 1));
  }
  return given.map((name) => {
    const value = own.get(name) ?? "";
    return envChange(name, /\p{Cc}/u.test(value) ? "" : value);
  });
}

/** Remove an image only if it carries the given MiniBox label (refuse to delete arbitrary images). */
export async function removeLabeledImage(
  host: HostCtx,
  ref: string,
  label: string,
  notFoundKey: "snapshot_not_found" | "template_not_found",
): Promise<void> {
  let info: ImageDetails;
  try {
    info = await host.runtime.inspectImage(ref);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) throw notFound(msg(notFoundKey));
    throw e;
  }
  if (info.labels[label] !== "true") throw notFound(msg(notFoundKey));
  await host.runtime.removeImage(ref, { force: true });
}
