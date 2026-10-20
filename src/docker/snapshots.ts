import { log } from "../lib/logger";
import { getBox } from "./boxes";
import type { DockerCtx } from "./client";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";

export function snapshotTag(prefix: string, base: string, now = new Date()): { repo: string; tag: string } {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return { repo: `${prefix}-snap`, tag: `${base}-${ts}` };
}

export const listSnapshots = (ctx: DockerCtx): Promise<ImageItem[]> => listImagesByLabel(ctx, ctx.keys.snapshot);

export async function createSnapshot(
  ctx: DockerCtx,
  boxId: string,
  name?: string,
): Promise<{ ref: string; source: string }> {
  const box = await getBox(ctx, boxId);
  const { repo, tag } = snapshotTag(ctx.prefix, name ?? box.name);
  const k = ctx.keys;
  await ctx.docker.getContainer(boxId).commit({
    repo,
    tag,
    comment: `MiniBox snapshot of ${box.name}`,
    author: "minibox",
    pause: true,
    changes: [
      `LABEL ${k.snapshot}=true`,
      `LABEL ${k.template}=false`,
      `LABEL ${k.snapshotOf}=${box.name}`,
      `LABEL ${k.templateName}=${name ?? box.name}`,
      `LABEL ${k.templateDesc}="Snapshot of box ${box.name}"`,
      `LABEL ${k.created}=${new Date().toISOString()}`,
      'CMD ["sleep","infinity"]',
    ],
  } as unknown as Record<string, unknown>);
  const ref = `${repo}:${tag}`;
  log.info("snapshot.created", { ref, box: box.name });
  return { ref, source: box.name };
}

export async function deleteSnapshot(ctx: DockerCtx, ref: string): Promise<void> {
  await removeLabeledImage(ctx, ref, ctx.keys.snapshot, "snapshot_not_found");
  log.info("snapshot.deleted", { ref });
}
