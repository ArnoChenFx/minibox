import { join } from "node:path";

import type { HostCtx } from "../host/registry";
import { notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";

export const listTemplates = (host: HostCtx): Promise<ImageItem[]> => listImagesByLabel(host, host.keys.template);

const BASE_DESCRIPTION = "Debian 12 · Node.js 24 · Python 3 · git · build-essential";

/** Re-tag a snapshot image as a template by committing a throwaway container with template labels. */
export async function promoteSnapshot(
  host: HostCtx,
  ref: string,
  name: string,
  description?: string,
): Promise<{ ref: string; name: string }> {
  const { runtime, keys: k, prefix } = host;
  const info = await runtime.inspectImage(ref).catch(() => null);
  const labels = info?.labels;
  const isSnapshot = labels?.[k.snapshot] === "true";
  if (!labels || !isSnapshot) throw notFound(msg("snapshot_not_found"));
  const source = labels[k.snapshotOf] ?? ref;
  const tmp = await runtime.createContainer({ image: ref, cmd: ["true"] });
  const repo = `${prefix}-template`;
  try {
    await runtime.commitContainer(tmp.id, {
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
    });
  } finally {
    await runtime.removeContainer(tmp.id, { force: true }).catch(() => {});
  }
  log.info("template.promoted", { from: ref, name });
  return { ref: `${repo}:${name}`, name };
}

export async function deleteTemplate(host: HostCtx, ref: string): Promise<void> {
  if (ref === host.baseTemplateTag) {
    // Allowed, but it can be rebuilt from templates/base.
    log.warn("template.base_deleted", { ref });
  }
  await removeLabeledImage(host, ref, host.keys.template, "template_not_found");
}

const builds = new Map<string, Promise<{ ref: string; output: string }>>();

/** Build the bundled base template from templates/base/Dockerfile. Concurrent calls on one host share one build. */
export function buildBaseTemplate(host: HostCtx): Promise<{ ref: string; output: string }> {
  const running = builds.get(host.host.id);
  if (running) return running;
  const build = (async () => {
    const k = host.keys;
    const output = await host.runtime.buildImage({
      contextDir: join(host.templatesDir, "base"),
      dockerfile: "Dockerfile",
      tag: host.baseTemplateTag,
      labels: { [k.template]: "true", [k.templateName]: "base", [k.templateDesc]: BASE_DESCRIPTION },
    });
    log.info("template.built", { ref: host.baseTemplateTag });
    return { ref: host.baseTemplateTag, output: output.slice(-4000) };
  })().finally(() => {
    builds.delete(host.host.id);
  });
  builds.set(host.host.id, build);
  return build;
}
