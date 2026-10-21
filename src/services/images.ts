import type { HostCtx } from "../host/registry";
import { parseImageLabels } from "../labels";
import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { type ImageDetails, type ImageSummary, isRuntimeError } from "../runtime";

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
