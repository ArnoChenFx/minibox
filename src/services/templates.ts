import type { HostCtx } from "../host/registry";
import { labelChange } from "../labels";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import { type ImageDetails, isRuntimeError } from "../runtime";
export { BASE_DESCRIPTION, buildBaseTemplate } from "./base-template";
import { getBox } from "./boxes";
import { type Progress, underBox } from "./checkpoints";
import { type ImageItem, listImagesByLabel, removeLabeledImage } from "./images";
import type { OfficialTemplate } from "./official-templates";
import { createSnapshot, deleteSnapshot } from "./snapshots";
import {
  type BuildKind,
  buildKindOf,
  type DeclaredTemplate,
  editRecipe,
  duplicateBaseDraftSource,
  duplicateDraftRecipe,
  duplicateOfficialDraftSource,
  duplicateRecipe,
  duplicateRecipeDraftSource,
  isDraftRecipe,
  listDraftRecipes,
  readRecipe,
  type RecipeEdit,
  removeRecipe,
  removeRecipeOfImage,
  templateInitOf,
  type TemplateRecipe,
  type TemplateSource,
} from "./template-builds";

export type TemplateItem = ImageItem & { buildKind?: BuildKind; postCreate?: string[]; forwardPorts?: number[] };

/**
 * The templates on this host. `buildKind` is set on a template built from a declared source, so a client can offer a
 * rebuild, and is left out for one saved from a box or made by other tools. `postCreate` and `forwardPorts` name the
 * setup a box created from the template gets, when its devcontainer.json asked for one. An image is only a template when
 * it carries the template tag or when a recipe names it: a layer a build left behind carries the template label and no
 * recipe, so it is not listed, even though the engine will not remove it.
 */
export async function listTemplates(host: HostCtx): Promise<TemplateItem[]> {
  const images = await listImagesByLabel(host, host.keys.template);
  const prefix = `${host.prefix}-template:`;
  return images
    .filter((image) => {
      if (image.tags.some((tag) => tag.startsWith(prefix))) return true;
      const recipe = image.name ? readRecipe(host, image.name) : null;
      return recipe !== null && recipe.imageId === image.id;
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
 * name too: building it is what turns the draft into the template, so a save, a build or a duplicate under that name would
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
 * A template a duplicate copies: the image the host holds, the name its tag gives, and the description its label carries. The
 * image is the one the host reported, so the recipe a duplicate copies is the one that built that image.
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
 * image the host holds, or is not labelled as a template, is not found, so a duplicate never copies a box image or a
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
 * Duplicates a template: a new template under `name` that can change on its own while the template it comes from stays as it
 * is, with its image, its tags, its labels and its boxes.
 *
 * A template built from a source, the bundled base template and an official template all have a build source, so the
 * duplicate is a draft: it copies the source, the setup, the ports and the description, and writes no image. Nothing is built,
 * so the duplicate has no image, no size and no creation time until `template.rebuild` builds it, exactly as a template saved
 * without building has none. A template saved from a box has no source to copy, so its duplicate stays the image copy it has
 * always been: a fresh commit of a throwaway container of the source image, labelled as a template of the new name, with
 * no recipe, so it cannot be rebuilt or edited, exactly as the template it came from. The same image copy is the
 * fallback for an official template whose shipped Dockerfile cannot become the duplicate's own copy, so such a duplicate keeps the
 * official source and the warning `duplicateRecipe` logs, and for a base template whose Dockerfile this MiniBox does not ship,
 * which leaves the copy without a recipe as it always did. The caller holds the new name through `holdingTemplateName`.
 */
export async function duplicateTemplate(
  host: HostCtx,
  source: TemplateSourceImage,
  input: { name: string; description?: string; createdBy: string },
): Promise<{ ref: string; name: string }> {
  const { runtime, keys: k, prefix } = host;
  const repo = `${prefix}-template`;
  const description =
    input.description ?? source.description ?? `Duplicated from template ${source.name || source.ref}`;
  const plan = duplicatePlan(host, source, input.name);
  if (plan.draft !== null) {
    duplicateDraftRecipe(host, {
      name: input.name,
      description,
      source: plan.draft,
      ...(source.recipe?.init === undefined ? {} : { init: source.recipe.init }),
      createdBy: input.createdBy,
    });
    log.info("template.duplicated", { from: source.ref, name: input.name, draft: true });
    return { ref: `${repo}:${input.name}`, name: input.name };
  }
  if (plan.missing !== null) {
    log.warn("template.duplicate_source_missing", { name: input.name, source: "base", reason: plan.missing });
  }
  const created = new Date().toISOString();
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
        // A duplicate is not a save of a box, so it names no box. An empty value reads back as none.
        labelChange(k.snapshotOf, ""),
        labelChange(k.snapshotOfId, ""),
        'CMD ["sleep","infinity"]',
      ],
    });
  } finally {
    await runtime.removeContainer(tmp.id, { force: true }).catch(() => {});
  }
  const duplicated = await runtime.inspectImage(`${repo}:${input.name}`);
  try {
    // Only the two fallbacks above reach this: a template with a source became a draft, and a template saved from a box
    // has no recipe. An official source that stayed official is the one recipe this writes.
    if (source.recipe) duplicateRecipe(host, input.name, source.recipe, duplicated.id, description, input.createdBy);
  } catch (e) {
    await runtime.removeImage(duplicated.id, { force: true }).catch(() => {});
    throw e;
  }
  log.info("template.duplicated", { from: source.ref, name: input.name });
  return { ref: `${repo}:${input.name}`, name: input.name };
}

/**
 * Duplicates an official template no host has built yet. There is no image to copy, so the copy is a draft holding a
 * copy of the Dockerfile this MiniBox ships for that template, as a duplicate of a built official template is: an
 * independent template that is not built, and that gets its own image, size and creation time when it is. A Dockerfile
 * this MiniBox cannot read, or does not accept as one, leaves nothing to copy, so the duplicate fails before anything is
 * written. The caller holds the name and has refused a reserved one.
 */
export function duplicateOfficialTemplate(
  host: HostCtx,
  official: OfficialTemplate,
  input: { name: string; description?: string; createdBy: string },
): { ref: string; name: string } {
  const read = duplicateOfficialDraftSource(host, official.name);
  if ("missing" in read) {
    log.warn("template.duplicate_source_missing", { name: official.name, source: "official", reason: read.missing });
    throw new AppError(500, "internal", msg("template_source_unreadable", { name: official.name }));
  }
  duplicateDraftRecipe(host, {
    name: input.name,
    description: input.description ?? official.description,
    source: read.source,
    createdBy: input.createdBy,
  });
  log.info("template.duplicated", { from: `${host.prefix}-template:${official.name}`, name: input.name, draft: true });
  return { ref: `${host.prefix}-template:${input.name}`, name: input.name };
}

/** How a duplicate makes its template: a draft from the source it copies, or the image copy a duplicate has always been. */
interface DuplicatePlan {
  /** The source the duplicate saves as a draft, or null when the duplicate commits a copy of the source image instead. */
  readonly draft: TemplateSource | null;
  /** Why the base template's Dockerfile cannot become the draft's source, when that is why the duplicate is an image copy. */
  readonly missing: string | null;
}

function duplicatePlan(host: HostCtx, source: TemplateSourceImage, name: string): DuplicatePlan {
  if (source.recipe) {
    const read = duplicateRecipeDraftSource(host, name, source.recipe);
    return { draft: "source" in read ? read.source : null, missing: null };
  }
  if (!isBaseTemplate(host, source)) return { draft: null, missing: null };
  const read = duplicateBaseDraftSource(host);
  return "source" in read ? { draft: read.source, missing: null } : { draft: null, missing: read.missing };
}

/**
 * The source a duplicate of `source` under `name` saves as a draft, or null when the duplicate is the image copy it has always
 * been. The operation checks the names MiniBox keeps for its own templates against this, so a draft that is never built
 * cannot take one.
 */
export function duplicateDraftSource(host: HostCtx, source: TemplateSourceImage, name: string): TemplateSource | null {
  return duplicatePlan(host, source, name).draft;
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

/**
 * Deletes a template: its image, and the recipe that built it. The bundled base template cannot be deleted, because the
 * helpers, the volumes and the egress proxy run on it; a ref that names an image rather than a template name is told
 * apart by its tags. The image is inspected again after the removal, so an engine that keeps an image another image is
 * built on (and reports success) answers `409 template_still_used` instead of a delete that did nothing. Only once the
 * image is gone is its recipe removed, whether the ref named the template or its image id.
 */
export async function deleteTemplate(host: HostCtx, ref: string): Promise<void> {
  const prefix = `${host.prefix}-template:`;
  const tagged = ref.startsWith(prefix);
  const name = tagged ? ref.slice(prefix.length) : NAME_RE.test(ref) ? ref : "";
  // An image id names no template by itself, so its tags are read to see whether it is the base template.
  const byId =
    name === ""
      ? await host.runtime.inspectImage(ref).catch((e: unknown) => {
          if (isRuntimeError(e, "not_found")) return null;
          throw e;
        })
      : null;
  if (
    ref === host.baseTemplateTag ||
    (ref === "base" && `${prefix}base` === host.baseTemplateTag) ||
    byId?.tags.includes(host.baseTemplateTag) === true
  ) {
    throw conflict(msg("template_builtin"));
  }
  // A draft has no image: its recipe is the whole template, so that is what a delete removes. A built template keeps the
  // path it always had, and only its template reference removes the recipe beside the image. The name is held for the
  // removal, so a build that is already running makes the delete answer `409 template_busy` instead of letting the build
  // put the template back after the delete has said it succeeded.
  if (NAME_RE.test(name) && isDraftRecipe(host, name)) {
    await holdingTemplate(host, name, async () => removeRecipe(host, name));
    return;
  }
  const image = await removeLabeledImage(host, ref, host.keys.template, "template_not_found", {
    stillUsedKey: "template_still_used",
  });
  // The image is gone, so the recipe it built has nothing left to describe. A template reference names the recipe; an
  // image id names it through the template name label, and only when the recipe is that image's own, so a recipe of the
  // same name that built another template is kept.
  if (tagged && NAME_RE.test(name)) removeRecipe(host, name);
  else if (byId !== null) removeRecipeOfImage(host, image.labels[host.keys.templateName] ?? "", image.id);
}
