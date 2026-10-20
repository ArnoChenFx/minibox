import { join } from "node:path";

import { notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { DockerCtx } from "./client";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";

export const listTemplates = (ctx: DockerCtx): Promise<ImageItem[]> => listImagesByLabel(ctx, ctx.keys.template);

export const BASE_DESCRIPTION = "Debian 12 · Node.js 24 · Python 3 · git · tmux · build-essential · non-root dev user";

/** Re-tag a snapshot image as a template by committing a throwaway container with template labels. */
export async function promoteSnapshot(
  ctx: DockerCtx,
  ref: string,
  name: string,
  description?: string,
): Promise<{ ref: string; name: string }> {
  const info = await ctx.docker
    .getImage(ref)
    .inspect()
    .catch(() => null);
  const labels = info?.Config?.Labels;
  const isSnapshot = labels?.[ctx.keys.snapshot] === "true";
  if (!labels || !isSnapshot) throw notFound(msg("snapshot_not_found"));
  const k = ctx.keys;
  const source = labels[k.snapshotOf] ?? ref;
  const tmp = await ctx.docker.createContainer({ Image: ref, Cmd: ["true"] });
  const repo = `${ctx.prefix}-template`;
  try {
    await tmp.commit({
      repo,
      tag: name,
      changes: [
        `LABEL ${k.template}=true`,
        `LABEL ${k.snapshot}=false`,
        `LABEL ${k.templateName}=${name}`,
        `LABEL ${k.templateDesc}="${(description ?? `Promoted from a snapshot of box ${source}`).replace(/"/g, "'")}"`,
        `LABEL ${k.created}=${new Date().toISOString()}`,
        'CMD ["sleep","infinity"]',
      ],
    } as unknown as Record<string, unknown>);
  } finally {
    await tmp.remove({ force: true }).catch(() => {});
  }
  log.info("template.promoted", { from: ref, name });
  return { ref: `${repo}:${name}`, name };
}

export async function deleteTemplate(ctx: DockerCtx, ref: string): Promise<void> {
  if (ref === ctx.baseTemplateTag) {
    // Allowed, but it can be rebuilt from templates/base.
    log.warn("template.base_deleted", { ref });
  }
  await removeLabeledImage(ctx, ref, ctx.keys.template, "template_not_found");
}

let building: Promise<{ ref: string; output: string }> | null = null;

/** Build the bundled base template from templates/base/Dockerfile. Concurrent calls share one build. */
export function buildBaseTemplate(ctx: DockerCtx): Promise<{ ref: string; output: string }> {
  if (building) return building;
  building = (async () => {
    const k = ctx.keys;
    const stream = await ctx.docker.buildImage(
      { context: join(ctx.templatesDir, "base"), src: ["Dockerfile"] },
      {
        t: ctx.baseTemplateTag,
        labels: { [k.template]: "true", [k.templateName]: "base", [k.templateDesc]: BASE_DESCRIPTION },
      },
    );
    const output = await new Promise<string>((resolve, reject) => {
      let out = "";
      ctx.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve(out)),
        (ev: { stream?: string; error?: string }) => {
          if (ev.stream) out += ev.stream;
          if (ev.error) reject(new Error(ev.error));
        },
      );
    });
    log.info("template.built", { ref: ctx.baseTemplateTag });
    return { ref: ctx.baseTemplateTag, output: output.slice(-4000) };
  })().finally(() => {
    building = null;
  });
  return building;
}
