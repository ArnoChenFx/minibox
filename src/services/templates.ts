import type { HostCtx } from "../host/registry";
import { labelChange } from "../labels";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import { type ImageDetails, isRuntimeError } from "../runtime";
export { BASE_DESCRIPTION, buildBaseTemplate } from "./base-template";
import { getBox } from "./boxes";
import { type Progress, underBox } from "./checkpoints";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";
import { createSnapshot, deleteSnapshot } from "./snapshots";
import {
  type BuildKind,
  buildKindOf,
  type DeclaredTemplate,
  editRecipe,
  forkBaseRecipe,
  forkRecipe,
  isDraftRecipe,
  listDraftRecipes,
  readRecipe,
  type RecipeEdit,
  removeRecipe,
  templateInitOf,
  type TemplateRecipe,
} from "./template-builds";

export type TemplateItem = ImageItem & { buildKind?: BuildKind; postCreate?: string[]; forwardPorts?: number[] };

/**
 * The templates on this host. `buildKind` is set on a template built from a declared source, so a client can offer a
 * rebuild, and is left out for one saved from a box or made by other tools. `postCreate` and `forwardPorts` name the
 * setup a box created from the template gets, when its devcontainer.json asked for one.
 */
export async function listTemplates(host: HostCtx): Promise<TemplateItem[]> {
  const images = await listImagesByLabel(host, host.keys.template);
  const prefix = `${host.prefix}-template:`;
  return images
    .filter((image) => {
      const recipe = image.name ? readRecipe(host, image.name) : null;
      return image.tags.some((tag) => tag.startsWith(prefix)) || !recipe || recipe.imageId === image.id;
    })
    .map((image) => {
      const tag = image.tags.find((t) => t.startsWith(prefix));
      const buildKind = tag === undefined ? null : buildKindOf(host, tag.slice(prefix.length), image.id);
      const init = tag === undefined ? null : templateInitOf(host, tag.slice(prefix.length), image.id);
      return {
        ...image,
        ...(buildKind === null ? {} : { buildKind }),
        ...(init?.postCreate === undefined ? {} : { postCreate: init.postCreate }),
        ...(init?.forwardPorts === undefined ? {} : { forwardPorts: init.forwardPorts }),
      };
    });
}

/**
 * Refuses a template name that is already taken. A commit to a tag that exists moves the tag without a word, so the
 * name is checked before the task starts, and again under the name hold just before the commit. A saved draft holds its
 * name too: building it is what turns the draft into the template, so a save, a build or a fork under that name would
 * overwrite the saved source.
 */
export async function assertTemplateNameAvailable(host: HostCtx, name: string): Promise<void> {
  const taken = await host.runtime.inspectImage(`${host.prefix}-template:${name}`).then(
    () => true,
    (e: unknown) => {
      if (isRuntimeError(e, "not_found")) return false;
      throw e;
    },
  );
  if (taken || isDraftRecipe(host, name)) throw conflict(msg("template_name_taken", { name }));
}

/** A template saved as a draft, as the draft list shows it: its source kind and description, and no image yet. */
export interface TemplateDraftItem {
  name: string;
  ref: string;
  description: string | null;
  buildKind: BuildKind;
}

/** The templates saved on this host that are not built yet. They are listed apart from `listTemplates`, which lists images. */
export function listTemplateDrafts(host: HostCtx): TemplateDraftItem[] {
  return listDraftRecipes(host).map((draft) => ({
    name: draft.name,
    ref: `${host.prefix}-template:${draft.name}`,
    description: draft.recipe.description,
    buildKind: draft.recipe.source.kind,
  }));
}

/** Template names a save, a promotion, a declared build or an edit is writing right now, as `<host id>:<name>`. */
const writing = new Set<string>();

/**
 * Runs `fn` holding `name` for this host, so no two writers to one recipe or tag overlap: a save, a promotion, a build, a
 * rebuild and an edit all take this lock. A second caller is refused with `409 template_busy`, so a caller is told to try
 * again rather than having its write overwritten by the one already running. The name itself is not checked here, because
 * an edit holds the name the template already has.
 */
export async function holdingTemplate<T>(host: HostCtx, name: string, fn: () => Promise<T>): Promise<T> {
  const key = `${host.host.id}:${name}`;
  if (writing.has(key)) throw conflict(msg("template_busy", { name }));
  writing.add(key);
  try {
    return await fn();
  } finally {
    writing.delete(key);
  }
}

/**
 * Runs `fn` holding `name` for this host, so two saves, promotions or builds to one name cannot both pass the check and
 * have the second commit move the tag over the first (which would leave the first image untagged). The name must also be
 * free. A second writer is refused as a taken name, which is what a caller racing for a new template is told.
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

/**
 * A template a fork copies: the image the host holds, the name its tag gives, and the description its label carries. The
 * image is the one the host reported, so the recipe a fork copies is the one that built that image.
 */
export interface TemplateSourceImage {
  readonly ref: string;
  readonly name: string;
  readonly image: ImageDetails;
  readonly description: string | null;
  /** The recipe captured with this image, or null for a template without a matching recipe. */
  readonly recipe: TemplateRecipe | null;
}

/**
 * The template `ref` names on `host`, which may be its image reference, its tag or its bare name. A ref that is not an
 * image the host holds, or is not labelled as a template, is not found, so a fork never copies a box image or a
 * snapshot.
 */
export async function templateSourceImage(host: HostCtx, ref: string): Promise<TemplateSourceImage> {
  const candidates = ref.startsWith(`${host.prefix}-template:`)
    ? [ref]
    : NAME_RE.test(ref)
      ? [ref, `${host.prefix}-template:${ref}`]
      : [ref];
  let image: ImageDetails | null = null;
  for (const candidate of candidates) {
    const found = await host.runtime.inspectImage(candidate).catch((e: unknown) => {
      if (isRuntimeError(e, "not_found")) return null;
      throw e;
    });
    // A plain image of the same name is passed over: the bare name of a template still means the template.
    if (found?.labels[host.keys.template] === "true") {
      image = found;
      break;
    }
  }
  if (!image) throw notFound(msg("template_not_found"));
  const prefix = `${host.prefix}-template:`;
  const tag = image.tags.find((candidate) => candidate.startsWith(prefix));
  const name = image.labels[host.keys.templateName] || (tag === undefined ? "" : tag.slice(prefix.length));
  const recipe = NAME_RE.test(name) ? readRecipe(host, name) : null;
  return {
    ref: tag ?? ref,
    name: NAME_RE.test(name) ? name : "",
    image,
    description: image.labels[host.keys.templateDesc] || null,
    recipe: recipe?.imageId === image.id ? recipe : null,
  };
}

/** Whether `source` is the bundled base template, which MiniBox builds itself and keeps no recipe for. */
function isBaseTemplate(host: HostCtx, source: TemplateSourceImage): boolean {
  return source.ref === host.baseTemplateTag || source.image.tags.includes(host.baseTemplateTag);
}

/**
 * Forks a template: a new template image under `name` that holds the same system layer, so its description and its
 * recipe can change without touching the template it came from. The image is a fresh commit of a throwaway container of
 * the source image, labelled as a template of the new name, so the source keeps its tags, its labels and its boxes. The
 * labels a fork records are the ones a build records, and the ones a saved template has, minus the box it came from: a
 * fork is its own template, not a save of a box. The caller holds the new name through `holdingTemplateName`.
 *
 * A template built from a declared source brings its recipe along, pointed at the new image, so `template.rebuild`
 * rebuilds the fork from the source of the template it came from. The bundled base template has no recipe, and its fork
 * gets one that holds the Dockerfile MiniBox ships for it, so the fork can be edited and rebuilt. A template with no
 * recipe otherwise, such as one saved from a box, forks too, and its fork has no recipe, so it cannot be rebuilt, exactly
 * as the template it came from.
 */
export async function forkTemplate(
  host: HostCtx,
  source: TemplateSourceImage,
  input: { name: string; description?: string; createdBy: string },
): Promise<{ ref: string; name: string }> {
  const { runtime, keys: k, prefix } = host;
  const created = new Date().toISOString();
  const repo = `${prefix}-template`;
  const description = input.description ?? source.description ?? `Forked from template ${source.name || source.ref}`;
  const tmp = await runtime.createContainer({ image: source.image.id, cmd: ["true"] });
  try {
    await runtime.commitContainer(tmp.id, {
      repo,
      tag: input.name,
      changes: [
        labelChange(k.template, "true"),
        labelChange(k.snapshot, "false"),
        labelChange(k.createdBy, input.createdBy),
        labelChange(k.templateName, input.name),
        labelChange(k.templateDesc, description),
        labelChange(k.created, created),
        // A fork is not a save of a box, so it names no box. An empty value reads back as none.
        labelChange(k.snapshotOf, ""),
        labelChange(k.snapshotOfId, ""),
        'CMD ["sleep","infinity"]',
      ],
    });
  } finally {
    await runtime.removeContainer(tmp.id, { force: true }).catch(() => {});
  }
  const forked = await runtime.inspectImage(`${repo}:${input.name}`);
  try {
    if (source.recipe) forkRecipe(host, input.name, source.recipe, forked.id, description, input.createdBy);
    else if (isBaseTemplate(host, source)) forkBaseRecipe(host, input.name, forked.id, description, input.createdBy);
  } catch (e) {
    await runtime.removeImage(forked.id, { force: true }).catch(() => {});
    throw e;
  }
  log.info("template.forked", { from: source.ref, name: input.name });
  return { ref: `${repo}:${input.name}`, name: input.name };
}

/**
 * Changes what a declared template would build next: its source, the setup a box created from it gets, and the
 * description. Nothing is built, so the image a box created right now starts from keeps its system layer; the next
 * `template.rebuild` builds the edited source into a new image. A template with no recipe, such as one saved from a box,
 * has nothing to edit, so the caller refuses it. The caller also holds the name through `holdingTemplate`, so a rebuild
 * or another edit cannot read the recipe while this writes it.
 *
 * A new description also re-commits the image under the same tag, because the description a card shows is the image's
 * label. The system layer is unchanged and the recipe's `imageId` follows the new image, so a rebuild still knows the
 * image it built. A commit that fails leaves the recipe and the image as they were.
 *
 * The source of a template MiniBox builds itself, an official one, cannot be replaced: its Dockerfile ships with MiniBox
 * and a rebuild uses the one of the running version, so writing another source there would quietly turn the template
 * into a custom one. Its setup and description are the template's own and stay editable.
 */
export async function editTemplate(
  host: HostCtx,
  declared: DeclaredTemplate,
  image: ImageDetails,
  edit: RecipeEdit,
): Promise<{ ref: string; name: string; buildKind: BuildKind }> {
  if (edit.source !== undefined && declared.recipe.source.kind === "official") {
    throw badRequest(msg("template_source_builtin", { name: declared.name }));
  }
  const description = edit.description;
  const current = image.labels[host.keys.templateDesc] || null;
  const relabelled =
    description === undefined || description === current || description === null
      ? image
      : await relabelTemplate(host, declared, image, description);
  const recipe = editRecipe(host, declared, edit, relabelled.id);
  if (relabelled.id !== image.id) {
    await host.runtime.removeImage(image.id, { force: false }).catch((error: unknown) => {
      log.warn("template.previous_image_kept", { image: image.id, error: String(error) });
    });
  }
  log.info("template.edited", { name: declared.name, kind: recipe.source.kind });
  return { ref: `${host.prefix}-template:${declared.name}`, name: declared.name, buildKind: recipe.source.kind };
}

/**
 * Writes `description` onto the template's image by committing a throwaway container of it to the same tag. The system
 * layer, the creator and the other labels are kept, so only the description a card reads changes. The caller points the
 * recipe at the returned image.
 */
async function relabelTemplate(
  host: HostCtx,
  declared: DeclaredTemplate,
  image: ImageDetails,
  description: string,
): Promise<ImageDetails> {
  const { runtime, keys: k, prefix } = host;
  const tmp = await runtime.createContainer({ image: image.id, cmd: ["true"] });
  try {
    await runtime.commitContainer(tmp.id, {
      repo: `${prefix}-template`,
      tag: declared.name,
      changes: [labelChange(k.templateDesc, description)],
    });
  } finally {
    await runtime.removeContainer(tmp.id, { force: true }).catch(() => {});
  }
  return runtime.inspectImage(`${prefix}-template:${declared.name}`);
}

export async function deleteTemplate(host: HostCtx, ref: string): Promise<void> {
  if (ref === host.baseTemplateTag) {
    // Allowed, but it can be rebuilt from templates/base.
    log.warn("template.base_deleted", { ref });
  }
  const prefix = `${host.prefix}-template:`;
  const tagged = ref.startsWith(prefix);
  const name = tagged ? ref.slice(prefix.length) : NAME_RE.test(ref) ? ref : "";
  // A draft has no image: its recipe is the whole template, so that is what a delete removes. A built template keeps the
  // path it always had, and only its template reference removes the recipe beside the image. The name is held for the
  // removal, so a build that is already running makes the delete answer `409 template_busy` instead of letting the build
  // put the template back after the delete has said it succeeded.
  if (NAME_RE.test(name) && isDraftRecipe(host, name)) {
    await holdingTemplate(host, name, async () => removeRecipe(host, name));
    return;
  }
  await removeLabeledImage(host, ref, host.keys.template, "template_not_found");
  if (tagged && NAME_RE.test(name)) removeRecipe(host, name);
}
