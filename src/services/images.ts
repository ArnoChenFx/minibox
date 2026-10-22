import type { HostCtx } from "../host/registry";
import { envChange, parseImageLabels } from "../labels";
import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { type ImageDetails, type ImageSummary, isRuntimeError } from "../runtime";
import type { Box } from "./boxes";

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
  const given = box.env.filter((entry) => entry.value !== undefined).map((entry) => entry.name);
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
