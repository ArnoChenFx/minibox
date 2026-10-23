import type { HostCtx } from "../host/registry";
import { labelChange } from "../labels";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import { isRuntimeError } from "../runtime";
export { BASE_DESCRIPTION, buildBaseTemplate } from "./base-template";
import { getBox } from "./boxes";
import { type Progress, underBox } from "./checkpoints";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";
import { createSnapshot, deleteSnapshot } from "./snapshots";
import { type BuildKind, buildKindOf, removeRecipe } from "./template-builds";

export type TemplateItem = ImageItem & { buildKind?: BuildKind };

/**
 * The templates on this host. `buildKind` is set on a template built from a declared source, so a client can offer a
 * rebuild, and is left out for one saved from a box or made by other tools.
 */
export async function listTemplates(host: HostCtx): Promise<TemplateItem[]> {
  const images = await listImagesByLabel(host, host.keys.template);
  const prefix = `${host.prefix}-template:`;
  return images.map((image) => {
    const tag = image.tags.find((t) => t.startsWith(prefix));
    const buildKind = tag === undefined ? null : buildKindOf(host, tag.slice(prefix.length), image.id);
    return buildKind === null ? image : { ...image, buildKind };
  });
}

/**
 * Refuses a template name that is already taken. A commit to a tag that exists moves the tag without a word, so the
 * name is checked before the task starts, and again under the name hold just before the commit.
 */
export async function assertTemplateNameAvailable(host: HostCtx, name: string): Promise<void> {
  const taken = await host.runtime.inspectImage(`${host.prefix}-template:${name}`).then(
    () => true,
    (e: unknown) => {
      if (isRuntimeError(e, "not_found")) return false;
      throw e;
    },
  );
  if (taken) throw conflict(msg("template_name_taken", { name }));
}

/** Template names a save, a promotion or a declared build is writing right now, as `<host id>:<name>`. */
const writing = new Set<string>();

/**
 * Runs `fn` holding `name` for this host, so two saves, promotions or builds to one name cannot both pass the check and have the
 * second commit move the tag over the first (which would leave the first image untagged). The name must also be free.
 */
export async function holdingTemplateName<T>(host: HostCtx, name: string, fn: () => Promise<T>): Promise<T> {
  const key = `${host.host.id}:${name}`;
  if (writing.has(key)) throw conflict(msg("template_name_taken", { name }));
  writing.add(key);
  try {
    await assertTemplateNameAvailable(host, name);
    return await fn();
  } finally {
    writing.delete(key);
  }
}

/** Re-tag a snapshot image as a template by committing a throwaway container with template labels. */
export function promoteSnapshot(
  host: HostCtx,
  ref: string,
  name: string,
  description?: string,
  createdBy = "owner",
): Promise<{ ref: string; name: string }> {
  return holdingTemplateName(host, name, () => promoteHeld(host, ref, name, description, createdBy));
}

async function promoteHeld(
  host: HostCtx,
  ref: string,
  name: string,
  description: string | undefined,
  createdBy: string,
): Promise<{ ref: string; name: string }> {
  const { runtime, keys: k, prefix } = host;
  const info = await runtime.inspectImage(ref).catch((e: unknown) => {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  });
  const labels = info?.labels;
  const isSnapshot = labels?.[k.snapshot] === "true";
  if (!labels || !isSnapshot) throw notFound(msg("snapshot_not_found"));
  const sourceName = labels[k.snapshotOf];
  const source = sourceName ?? ref;
  const sourceId = labels[k.snapshotOfId];
  const tmp = await runtime.createContainer({ image: ref, cmd: ["true"] });
  const repo = `${prefix}-template`;
  try {
    await runtime.commitContainer(tmp.id, {
      repo,
      tag: name,
      changes: [
        labelChange(k.template, "true"),
        labelChange(k.snapshot, "false"),
        labelChange(k.createdBy, createdBy),
        ...(sourceName ? [labelChange(k.snapshotOf, sourceName)] : []),
        ...(sourceId ? [labelChange(k.snapshotOfId, sourceId)] : []),
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

/**
 * Saves a box's system layer as a template: the packages it installed and the system files it changed. Its volumes are
 * left out, so a template never carries the box's files, and a checkpoint keeps those. The box is committed as a
 * snapshot, the snapshot is promoted, and then the snapshot is removed, whether or not the promotion worked. The box's
 * power lock is held for the commit, as it is for a checkpoint.
 */
export async function saveBoxAsTemplate(
  host: HostCtx,
  ref: string,
  input: { name: string; description?: string },
  createdBy: string,
  progress?: Progress,
): Promise<{ ref: string; name: string }> {
  const { boxId } = await getBox(host, ref);
  return underBox(host, boxId, (box) =>
    holdingTemplateName(host, input.name, async () => {
      const snapshot = await createSnapshot(host, box.boxId, input.name, progress, createdBy);
      try {
        progress?.log?.(`Saving ${box.name} as template ${input.name}…\n`);
        const template = await promoteHeld(
          host,
          snapshot.ref,
          input.name,
          input.description ?? `Saved from box ${box.name}`,
          createdBy,
        );
        progress?.log?.(`Saved ${template.ref}\n`);
        return template;
      } finally {
        await deleteSnapshot(host, snapshot.ref).catch((e: unknown) => {
          log.warn("template.snapshot_left", { ref: snapshot.ref, error: String(e) });
        });
      }
    }),
  );
}

export async function deleteTemplate(host: HostCtx, ref: string): Promise<void> {
  if (ref === host.baseTemplateTag) {
    // Allowed, but it can be rebuilt from templates/base.
    log.warn("template.base_deleted", { ref });
  }
  await removeLabeledImage(host, ref, host.keys.template, "template_not_found");
  const prefix = `${host.prefix}-template:`;
  const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  if (NAME_RE.test(name)) removeRecipe(host, name);
}
