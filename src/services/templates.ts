import { join } from "node:path";

import type { HostCtx } from "../host/registry";
import { labelChange } from "../labels";
import { notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { isRuntimeError } from "../runtime";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";

export const listTemplates = (host: HostCtx): Promise<ImageItem[]> => listImagesByLabel(host, host.keys.template);

export const BASE_DESCRIPTION = "Debian 12 · Node.js 24 · Python 3 · git · tmux · build-essential · non-root dev user";

/** Re-tag a snapshot image as a template by committing a throwaway container with template labels. */
export async function promoteSnapshot(
  host: HostCtx,
  ref: string,
  name: string,
  description?: string,
): Promise<{ ref: string; name: string }> {
  const { runtime, keys: k, prefix } = host;
  const info = await runtime.inspectImage(ref).catch((e: unknown) => {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  });
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
        labelChange(k.template, "true"),
        labelChange(k.snapshot, "false"),
        labelChange(k.templateName, name),
        labelChange(k.templateDesc, description ?? `Promoted from a snapshot of box ${source}`),
        labelChange(k.created, new Date().toISOString()),
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

/**
 * Build the bundled base template from templates/base/Dockerfile. One build at a time is enforced by the task mutex,
 * not here, so a direct caller can run more than one.
 */
export async function buildBaseTemplate(
  host: HostCtx,
  progress?: { readonly signal?: AbortSignal; log?(text: string): void },
): Promise<{ ref: string; output: string }> {
  const k = host.keys;
  const output = await host.runtime.buildImage({
    contextDir: join(host.templatesDir, "base"),
    dockerfile: "Dockerfile",
    tag: host.baseTemplateTag,
    labels: { [k.template]: "true", [k.templateName]: "base", [k.templateDesc]: BASE_DESCRIPTION },
    onLog: (chunk) => progress?.log?.(chunk),
    signal: progress?.signal,
  });
  log.info("template.built", { ref: host.baseTemplateTag });
  return { ref: host.baseTemplateTag, output };
}
