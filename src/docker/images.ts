import type Docker from "dockerode";

import { parseImageLabels } from "../labels";
import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { DockerCtx } from "./client";

export interface ImageItem {
  id: string;
  ref: string;
  tags: string[];
  name: string;
  description: string | null;
  source: string | null;
  createdAt: string;
  size: number;
}

export function toImageItem(ctx: DockerCtx, img: Docker.ImageInfo): ImageItem {
  const labels = parseImageLabels(img.Labels, ctx.keys);
  const tags = (img.RepoTags ?? []).filter((t) => t !== "<none>:<none>");
  const ref = tags[0] ?? img.Id;
  return {
    id: img.Id,
    ref,
    tags,
    name: labels.templateName ?? ref.split(":").pop() ?? ref,
    description: labels.description,
    source: labels.snapshotOf,
    createdAt: labels.created ?? new Date(img.Created * 1000).toISOString(),
    size: img.Size,
  };
}

export async function listImagesByLabel(ctx: DockerCtx, label: string): Promise<ImageItem[]> {
  const images = await ctx.docker.listImages({ filters: { label: [`${label}=true`] } });
  return images.map((i) => toImageItem(ctx, i)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Remove an image only if it carries the given MiniBox label (refuse to delete arbitrary images). */
export async function removeLabeledImage(
  ctx: DockerCtx,
  ref: string,
  label: string,
  notFoundKey: "snapshot_not_found" | "template_not_found",
): Promise<void> {
  let info: Docker.ImageInspectInfo;
  try {
    info = await ctx.docker.getImage(ref).inspect();
  } catch {
    throw notFound(msg(notFoundKey));
  }
  if (info.Config?.Labels?.[label] !== "true") throw notFound(msg(notFoundKey));
  await ctx.docker.getImage(ref).remove({ force: true });
}
