import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DIR_MODE, writeFileAtomic } from "../data-dir";
import type { HostCtx } from "../host/registry";
import { DEVCONTAINER_PATHS, type DevcontainerPlan, envInstructions, readDevcontainer } from "../lib/devcontainer";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { dockerfileProblem, resolveInside } from "../lib/source";
import { NAME_RE } from "../lib/validation";
import { type ImageDetails, isRuntimeError } from "../runtime";
import { assertDirIn, assertFileIn, extractContextUrl, pathParts } from "./build-context";
import { cloneInto, copyVolumeOut, ROOT_OWNER } from "./git-clone";
import { type OfficialName, officialContextDir, officialTemplate } from "./official-templates";

export const BUILD_KINDS = ["dockerfile", "git", "context", "devcontainer", "official"] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

/** A devcontainer.json larger than this is refused unread, and so is a repository Dockerfile larger than it. */
const REPO_FILE_MAX_BYTES = 256 * 1024;

/**
 * Where a declared template's files come from. A Dockerfile is pasted in and kept in the recipe. The other kinds are
 * fetched on every build, so a rebuild picks up the newest commit or archive. Credentials are never stored here:
 * `secretRef` names a secret the clone reads when it runs. An official template's Dockerfile ships with MiniBox, so its
 * recipe keeps only the name, and a rebuild uses the Dockerfile of the running version.
 */
export type TemplateSource =
  | { kind: "dockerfile"; text: string }
  | { kind: "git"; url: string; branch?: string; subdir?: string; dockerfile?: string; secretRef?: string }
  | { kind: "context"; url: string; dockerfile?: string }
  | { kind: "devcontainer"; url: string; branch?: string; path?: string; secretRef?: string }
  | { kind: "official"; name: OfficialName };

/**
 * What a box created from a declared template does once it exists: its postCreateCommand as argv, and the ports its
 * devcontainer.json forwards. It lives in the recipe, not on the image, so a box saved from that template inherits none.
 */
export interface TemplateInit {
  postCreate?: string[];
  forwardPorts?: number[];
}

export interface TemplateRecipe {
  version: 1;
  /** The image the recipe last built. A rebuild refuses an image that the recipe did not build, such as a saved one. */
  imageId: string;
  /** The description the caller gave, or null for the default. */
  description: string | null;
  createdBy: string;
  /** When the recipe last built the image. */
  created: string;
  source: TemplateSource;
  /** Set when the devcontainer.json the template was built from asks for a postCreateCommand or forwarded ports. */
  init?: TemplateInit;
}

export interface DeclaredTemplate {
  name: string;
  imageId: string;
  recipe: TemplateRecipe;
}

export interface BuildProgress {
  log?(text: string): void;
  signal?: AbortSignal;
}

const recipesDir = (host: HostCtx) => join(dirname(host.specs.dir()), "template-recipes", host.host.id);

function recipePath(host: HostCtx, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`refusing a recipe for name ${name}`);
  return join(recipesDir(host), `${name}.json`);
}

function isSource(value: unknown): value is TemplateSource {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "official") {
    return "name" in value && typeof value.name === "string" && officialTemplate(value.name) !== undefined;
  }
  return (BUILD_KINDS as readonly unknown[]).includes(value.kind);
}

function isInit(value: unknown): value is TemplateInit {
  if (typeof value !== "object" || value === null) return false;
  const { postCreate, forwardPorts } = value as Partial<Record<keyof TemplateInit, unknown>>;
  const commandOk =
    postCreate === undefined || (Array.isArray(postCreate) && postCreate.every((item) => typeof item === "string"));
  const portsOk =
    forwardPorts === undefined ||
    (Array.isArray(forwardPorts) &&
      forwardPorts.every((port) => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535));
  return commandOk && portsOk;
}

/** The recipe a declared template was built from, or null for a template made some other way. */
export function readRecipe(host: HostCtx, name: string): TemplateRecipe | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recipePath(host, name), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const recipe = parsed as Partial<TemplateRecipe>;
  if (recipe.version !== 1 || typeof recipe.imageId !== "string" || !isSource(recipe.source)) return null;
  if (recipe.init !== undefined && !isInit(recipe.init)) return null;
  return recipe as TemplateRecipe;
}

function writeRecipe(host: HostCtx, name: string, recipe: TemplateRecipe): void {
  mkdirSync(recipesDir(host), { recursive: true, mode: DIR_MODE });
  writeFileAtomic(recipePath(host, name), `${JSON.stringify(recipe, null, 2)}\n`);
}

/**
 * What a caller may change about a declared template's recipe without building it: where its files come from, the setup a
 * box created from it gets, and the description. A field left out keeps the value the recipe has, so a caller that only
 * edits the Dockerfile does not have to send the rest. `init` merges field by field for the same reason: a caller that only
 * sets `forwardPorts` keeps the `postCreateCommand` the template has. `init: null`, and an `init` with no field in it, drop
 * the setup, because that is how a caller asks for none.
 */
export interface RecipeEdit {
  source?: TemplateSource;
  init?: TemplateInit | null;
  description?: string | null;
}

/**
 * Replaces the parts of a declared template's recipe that `edit` names, so the next rebuild builds the edited source. The
 * creator and the rest of the recipe stay as they are: an edit changes what a rebuild would produce, not the image a box
 * created now starts from. `imageId` is the image the tag names after the edit, which a description change commits anew. The
 * caller has checked that the recipe built that image.
 */
export function editRecipe(
  host: HostCtx,
  declared: DeclaredTemplate,
  edit: RecipeEdit,
  imageId = declared.imageId,
): TemplateRecipe {
  const init =
    edit.init === null || (edit.init !== undefined && Object.keys(edit.init).length === 0) ? null : edit.init;
  const next: TemplateRecipe = { ...declared.recipe, imageId };
  // A field the caller left out keeps the value the recipe has, so only the ones it named are written.
  if (edit.source !== undefined) next.source = edit.source;
  if (edit.description !== undefined) next.description = edit.description;
  // An empty setup asks for nothing, which is the same as dropping it. A setup that names one field keeps the other, so
  // `--forward-port 8080` alone does not throw away the command the template runs.
  if (init === null) delete next.init;
  else if (init !== undefined) {
    const merged = {
      ...(declared.recipe.init?.postCreate === undefined ? {} : { postCreate: declared.recipe.init.postCreate }),
      ...(init.postCreate === undefined ? {} : { postCreate: init.postCreate }),
      ...(declared.recipe.init?.forwardPorts === undefined ? {} : { forwardPorts: declared.recipe.init.forwardPorts }),
      ...(init.forwardPorts === undefined ? {} : { forwardPorts: init.forwardPorts }),
    };
    if (Object.keys(merged).length === 0) delete next.init;
    else next.init = merged;
  }
  writeRecipe(host, declared.name, next);
  return next;
}

/** Forgets the recipe of a template name. A recipe whose image was removed by another tool is harmless and is replaced. */
export function removeRecipe(host: HostCtx, name: string): void {
  rmSync(recipePath(host, name), { force: true });
}

/**
 * Gives `to` the recipe that built the template `ref` on `from`, when that recipe names `imageId`. A copy of a declared
 * template keeps its setup and can be rebuilt on `to`; a saved or rebuilt image matches no recipe, so it copies none.
 */
export function copyRecipe(from: HostCtx, to: HostCtx, ref: string, imageId: string): void {
  const prefix = `${from.prefix}-template:`;
  if (!ref.startsWith(prefix)) return;
  const name = ref.slice(prefix.length);
  if (!NAME_RE.test(name)) return;
  const recipe = readRecipe(from, name);
  if (!recipe || recipe.imageId !== imageId || readRecipe(to, name)?.imageId === imageId) return;
  writeRecipe(to, name, recipe);
}

/**
 * Gives `to` the recipe captured with the source image, pointed at the fork's image. A source rebuilt while the fork
 * runs cannot replace this recipe. The fork's description and creator belong to the fork and survive its rebuilds.
 */
export function forkRecipe(
  host: HostCtx,
  to: string,
  recipe: TemplateRecipe,
  imageId: string,
  description: string,
  createdBy: string,
): void {
  writeRecipe(host, to, { ...recipe, imageId, description, createdBy, created: new Date().toISOString() });
}

/** How a template was built, when its image still matches the recipe that built it. */
export function buildKindOf(host: HostCtx, name: string, imageId: string): BuildKind | null {
  if (!NAME_RE.test(name)) return null;
  const recipe = readRecipe(host, name);
  return recipe && recipe.imageId === imageId ? recipe.source.kind : null;
}

/** The declared template named by `ref`, which must be a template image this recipe built. */
export async function declaredTemplate(host: HostCtx, ref: string): Promise<DeclaredTemplate> {
  return (await templateAndRecipe(host, ref))[0];
}

/**
 * The declared template `ref` names, with its recipe and the image the host reported. The image is the one the recipe must
 * have built, so a caller that edits the recipe knows the image it names stays as it is. The ref may be the image
 * reference, the tag or the bare name, as `templateSourceImage` accepts them. A candidate that is an image but not a
 * template is passed over rather than ending the search: a host may hold a plain image named, say, `node` beside the
 * template of that name, and the bare name still means the template.
 */
export async function templateAndRecipe(host: HostCtx, ref: string): Promise<[DeclaredTemplate, ImageDetails]> {
  const prefix = `${host.prefix}-template:`;
  const candidates = ref.startsWith(prefix) ? [ref] : NAME_RE.test(ref) ? [ref, `${prefix}${ref}`] : [ref];
  let image: ImageDetails | null = null;
  for (const candidate of candidates) {
    const found = await host.runtime.inspectImage(candidate).catch((e: unknown) => {
      if (isRuntimeError(e, "not_found")) return null;
      throw e;
    });
    if (found?.labels[host.keys.template] === "true") {
      image = found;
      break;
    }
  }
  if (!image) throw notFound(msg("template_not_found"));
  const tag = image.tags.find((candidate) => candidate.startsWith(prefix));
  const name = image.labels[host.keys.templateName] || (tag === undefined ? "" : tag.slice(prefix.length));
  if (!NAME_RE.test(name)) throw notFound(msg("template_not_found"));
  const recipe = readRecipe(host, name);
  if (!recipe || recipe.imageId !== image.id) throw badRequest(msg("template_not_declared", { name }));
  // Older forks copied the source's creator into the recipe. The image's label is the ownership authority.
  const createdBy = image.labels[host.keys.createdBy] || recipe.createdBy;
  return [{ name, imageId: image.id, recipe: { ...recipe, createdBy } }, image];
}

/**
 * The setup the template name's recipe recorded for the image `imageId`, when the image is the one the recipe built.
 * The template list calls it for images the template label already marks; a caller that reads an arbitrary ref checks
 * the label first, as `templateSetupOf` does.
 */
export function templateInitOf(host: HostCtx, name: string, imageId: string): TemplateInit | null {
  if (!NAME_RE.test(name)) return null;
  const recipe = readRecipe(host, name);
  return recipe && recipe.imageId === imageId ? (recipe.init ?? null) : null;
}

/**
 * The setup a box created from `ref` gets: the postCreateCommand and forwarded ports its declared template was built
 * with. A template that was not declared, or whose image its recipe did not build, has none.
 */
export async function templateSetupOf(host: HostCtx, ref: string): Promise<TemplateInit | null> {
  const prefix = `${host.prefix}-template:`;
  const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
  if (name === null || !NAME_RE.test(name)) return null;
  let image: ImageDetails;
  try {
    image = await host.runtime.inspectImage(ref);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  }
  if (image.labels[host.keys.template] !== "true") return null;
  return templateInitOf(host, name, image.id);
}

/** The description a template gets when none is given, so the label is never empty. */
export function defaultDescription(source: TemplateSource): string {
  if (source.kind === "dockerfile") return "Built from a Dockerfile";
  if (source.kind === "git") return `Built from ${source.url}${source.branch ? ` (${source.branch})` : ""}`;
  if (source.kind === "devcontainer")
    return `Built from ${source.url}${source.branch ? ` (${source.branch})` : ""}, devcontainer.json`;
  if (source.kind === "official")
    return officialTemplate(source.name)?.description ?? "Built from an official template";
  return `Built from ${source.url}`;
}

interface BuildContext {
  contextDir: string;
  dockerfile: string;
  src: string[];
  args: Record<string, string>;
  /** The stage to build, when the devcontainer.json names one. */
  target?: string;
  init?: TemplateInit;
  /** What a devcontainer.json sets that is not applied. The build log shows each one. */
  warnings?: readonly string[];
}

type RepoInput = { url: string; branch?: string; secretRef?: string };

/** Reads a repository file of at most `max` bytes, as text. */
async function readRepoFile(path: string, max: number, what: string): Promise<string> {
  const info = await stat(path);
  if (info.size > max) throw badRequest(msg("context_invalid", { detail: `${what} is larger than ${max / 1024} KB` }));
  return readFile(path, "utf8");
}

/**
 * The devcontainer.json a repository holds: the file at `path` when one is given, otherwise the first of the spec's
 * locations that exists. Returns its path relative to the repository root.
 */
async function locateDevcontainer(root: string, path: string | undefined): Promise<string> {
  const missing = msg("devcontainer_missing", { path: path ?? DEVCONTAINER_PATHS[0] });
  if (path !== undefined) {
    await assertFileIn(root, path, missing);
    return pathParts(path).join("/");
  }
  for (const candidate of DEVCONTAINER_PATHS) {
    const info = await lstat(join(root, candidate)).catch(() => null);
    if (info?.isFile() || info?.isSymbolicLink()) {
      await assertFileIn(root, candidate, missing);
      return candidate;
    }
  }
  throw badRequest(missing, { field: "source" });
}

/** The stage names a Dockerfile declares with FROM … AS, in lower case, which is how Docker matches a stage. */
function stageNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*\S+(?:\s+as\s+(\S+))?/gim)) {
    if (match[1]) names.add(match[1].toLowerCase());
  }
  return names;
}

/** The setup a plan asks for, or none when it asks for neither a command nor a port. */
function initOf(plan: DevcontainerPlan): TemplateInit | undefined {
  const init: TemplateInit = {
    ...(plan.postCreate === undefined ? {} : { postCreate: plan.postCreate }),
    ...(plan.forwardPorts.length === 0 ? {} : { forwardPorts: plan.forwardPorts }),
  };
  return Object.keys(init).length === 0 ? undefined : init;
}

/**
 * Builds from the devcontainer.json of a cloned repository. An `image` becomes `FROM` in a Dockerfile of its own. A
 * `build` uses the repository's Dockerfile and context, both inside the repository and resolved from the file's directory.
 * containerEnv and remoteEnv go in as ENV instructions: for a `build`, in a copy of the Dockerfile that sits in the context,
 * so the repository's file is never changed. A `build.target` is built as the stage that the copy adds on top of it, when
 * there is an environment to add. The setup the file asks for goes back with the context, and what it does not apply goes
 * back as warnings.
 */
async function devcontainerContext(
  source: Extract<TemplateSource, { kind: "devcontainer" }>,
  root: string,
  work: string,
  progress: BuildProgress,
): Promise<BuildContext> {
  const configPath = await locateDevcontainer(root, source.path);
  progress.log?.(`Reading ${configPath}\n`);
  const text = await readRepoFile(join(root, configPath), REPO_FILE_MAX_BYTES, configPath);
  const reading = readDevcontainer(text);
  if ("problem" in reading) throw badRequest(reading.problem, { field: "source" });
  const { plan } = reading;
  const init = initOf(plan);
  const warnings = plan.warnings;
  const configDir = configPath.split("/").slice(0, -1);
  if (plan.base.kind === "image") {
    const dir = join(work, "image");
    await mkdir(dir, { mode: 0o755 });
    await writeFile(join(dir, "Dockerfile"), `FROM ${plan.base.image}\n${envInstructions(plan.env)}`, { mode: 0o644 });
    return { contextDir: dir, dockerfile: "Dockerfile", src: ["Dockerfile"], args: {}, init, warnings };
  }
  const base = plan.base;
  const env = plan.env;
  const contextParts = resolveInside(configDir, base.context);
  const dockerfileParts = resolveInside(configDir, base.dockerfile);
  const inside =
    contextParts !== null &&
    dockerfileParts !== null &&
    dockerfileParts.length > contextParts.length &&
    contextParts.every((part, i) => dockerfileParts[i] === part);
  if (!contextParts || !dockerfileParts || !inside) {
    throw badRequest(msg("devcontainer_path_invalid"), { field: "source" });
  }
  const contextDir = join(root, ...contextParts);
  await assertDirIn(root, contextDir);
  const dockerfile = dockerfileParts.slice(contextParts.length).join("/");
  await assertFileIn(contextDir, dockerfile);
  const hasEnv = Object.keys(env).length > 0;
  if (base.target === undefined && !hasEnv) {
    return { contextDir, dockerfile, src: readdirSync(contextDir), args: base.args, init, warnings };
  }
  const original = await readRepoFile(join(contextDir, dockerfile), REPO_FILE_MAX_BYTES, dockerfile);
  if (base.target !== undefined && !stageNames(original).has(base.target.toLowerCase())) {
    throw badRequest(msg("devcontainer_target_missing", { target: base.target }), { field: "source" });
  }
  if (!hasEnv) {
    return {
      contextDir,
      dockerfile,
      src: readdirSync(contextDir),
      args: base.args,
      target: base.target,
      init,
      warnings,
    };
  }
  const copy = `.minibox-env-${randomBytes(6).toString("hex")}.Dockerfile`;
  const separator = original.endsWith("\n") ? "" : "\n";
  const stage = base.target === undefined ? "" : `FROM ${base.target} AS minibox-env\n`;
  await writeFile(join(contextDir, copy), `${original}${separator}${stage}${envInstructions(env)}`, { mode: 0o644 });
  return {
    contextDir,
    dockerfile: copy,
    src: readdirSync(contextDir),
    args: base.args,
    ...(base.target === undefined ? {} : { target: "minibox-env" }),
    init,
    warnings,
  };
}

/** Writes the source's files into `work`, and returns the directory and Dockerfile the engine builds from. */
async function materialize(
  host: HostCtx,
  source: TemplateSource,
  work: string,
  progress: BuildProgress,
): Promise<BuildContext> {
  if (source.kind === "dockerfile") {
    if (dockerfileProblem(source.text)) throw badRequest(msg("dockerfile_invalid"), { field: "source" });
    await writeFile(join(work, "Dockerfile"), source.text, { mode: 0o644 });
    return { contextDir: work, dockerfile: "Dockerfile", src: ["Dockerfile"], args: {} };
  }
  if (source.kind === "official") {
    return {
      contextDir: officialContextDir(host, source.name),
      dockerfile: "Dockerfile",
      src: ["Dockerfile"],
      args: {},
    };
  }
  const root = join(work, "src");
  await mkdir(root, { mode: 0o755 });
  if (source.kind === "context") {
    progress.log?.(`Downloading ${source.url}…\n`);
    await extractContextUrl(source.url, root, progress.signal);
    const dockerfile = pathParts(source.dockerfile ?? "Dockerfile").join("/");
    await assertFileIn(root, dockerfile);
    return { contextDir: root, dockerfile, src: readdirSync(root), args: {} };
  }
  progress.log?.(`Cloning ${source.url}…\n`);
  await cloneRepo(host, source, root, progress);
  if (source.kind === "devcontainer") return devcontainerContext(source, root, work, progress);
  const contextDir = join(root, ...pathParts(source.subdir ?? ""));
  await assertDirIn(root, contextDir);
  const dockerfile = pathParts(source.dockerfile ?? "Dockerfile").join("/");
  await assertFileIn(contextDir, dockerfile);
  return { contextDir, dockerfile, src: readdirSync(contextDir), args: {} };
}

/** Clones a repository into a volume made for this build, copies it out, and removes the volume whatever happened. */
async function cloneRepo(host: HostCtx, repo: RepoInput, root: string, progress: BuildProgress): Promise<void> {
  const volume = `${host.prefix}-src-${randomBytes(6).toString("hex")}`;
  await host.runtime.createVolume(volume, { [host.keys.internal]: "true" });
  try {
    await cloneInto(host, { repo, volume, path: "/work", owner: ROOT_OWNER, log: progress.log });
    await copyVolumeOut(host, volume, "/work", root);
  } finally {
    await host.runtime.removeVolume(volume).catch((e: unknown) => {
      log.warn("template.source_volume_left", { volume, error: String(e) });
    });
  }
}

/**
 * Builds `source` into the image `${prefix}-template:${name}`. Returns the image and the setup the source asks for, or
 * throws with the tag untouched. Each warning about a setting that is not applied goes to the build log first.
 */
async function buildImageFrom(
  host: HostCtx,
  build: { name: string; source: TemplateSource; description: string; createdBy: string; created: string },
  progress: BuildProgress,
): Promise<{ image: ImageDetails; init?: TemplateInit }> {
  const tag = `${host.prefix}-template:${build.name}`;
  const work = await mkdtemp(join(tmpdir(), "minibox-template-"));
  try {
    const context = await materialize(host, build.source, work, progress);
    for (const warning of context.warnings ?? []) progress.log?.(`Warning: ${warning}\n`);
    await host.runtime.buildImage({
      contextDir: context.contextDir,
      dockerfile: context.dockerfile,
      src: context.src,
      args: context.args,
      ...(context.target === undefined ? {} : { target: context.target }),
      tag,
      labels: {
        [host.keys.template]: "true",
        [host.keys.templateName]: build.name,
        [host.keys.templateDesc]: build.description,
        [host.keys.createdBy]: build.createdBy,
        [host.keys.created]: build.created,
      },
      onLog: (chunk) => progress.log?.(chunk),
      signal: progress.signal,
    });
    return { image: await host.runtime.inspectImage(tag), init: context.init };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface NewTemplate {
  name: string;
  description?: string;
  source: TemplateSource;
  createdBy: string;
}

/**
 * Builds a new declared template. The caller holds the name through `holdingTemplateName`, so no save or promotion
 * takes it while this runs. A build that fails leaves no image and no recipe.
 */
export async function createDeclaredTemplate(
  host: HostCtx,
  input: NewTemplate,
  progress: BuildProgress,
): Promise<{ ref: string; name: string }> {
  const created = new Date().toISOString();
  const built = await buildImageFrom(
    host,
    {
      name: input.name,
      source: input.source,
      description: input.description ?? defaultDescription(input.source),
      createdBy: input.createdBy,
      created,
    },
    progress,
  );
  const image = built.image;
  try {
    writeRecipe(host, input.name, {
      version: 1,
      imageId: image.id,
      description: input.description ?? null,
      createdBy: input.createdBy,
      created,
      source: input.source,
      ...(built.init === undefined ? {} : { init: built.init }),
    });
  } catch (e) {
    await host.runtime.removeImage(image.id, { force: true }).catch(() => {});
    throw e;
  }
  log.info("template.created", { name: input.name, kind: input.source.kind });
  return { ref: `${host.prefix}-template:${input.name}`, name: input.name };
}

/**
 * Builds a declared template again from its recipe, so a branch or an archive URL yields its newest content. The tag
 * moves only when the build succeeds, so a failed rebuild keeps the image the template had. The image it replaced is
 * removed when no box still runs it.
 *
 * The recipe is read again here rather than taken from `declared`: the operation resolves it before the task takes the
 * name, and an edit that lands in that gap would otherwise be overwritten by the recipe this build started from. A
 * recipe that changed in the gap, or an image that is no longer the one the tag names, is refused as `template_busy`
 * instead, so the caller retries against what the template now holds.
 */
export async function rebuildDeclaredTemplate(
  host: HostCtx,
  declared: DeclaredTemplate,
  progress: BuildProgress,
): Promise<{ ref: string; name: string }> {
  const { name } = declared;
  const current = await declaredTemplate(host, `${host.prefix}-template:${name}`);
  if (current.imageId !== declared.imageId || JSON.stringify(current.recipe) !== JSON.stringify(declared.recipe)) {
    throw conflict(msg("template_busy", { name }));
  }
  const { recipe } = current;
  const created = new Date().toISOString();
  const built = await buildImageFrom(
    host,
    {
      name,
      source: recipe.source,
      description: recipe.description ?? defaultDescription(recipe.source),
      createdBy: recipe.createdBy,
      created,
    },
    progress,
  );
  const next: TemplateRecipe = { ...recipe, imageId: built.image.id, created };
  // A devcontainer.json names its own setup, so a rebuild takes the one the newest file asks for and drops one it no
  // longer has. A Dockerfile, a repository or an archive names none, and the setup an edit wrote belongs to the template:
  // dropping it there would undo that edit.
  const init = recipe.source.kind === "devcontainer" ? built.init : (built.init ?? recipe.init);
  if (init === undefined) delete next.init;
  else next.init = init;
  writeRecipe(host, name, next);
  if (built.image.id !== declared.imageId) {
    await host.runtime.removeImage(declared.imageId, { force: false }).catch((e: unknown) => {
      log.warn("template.previous_image_kept", { name, image: declared.imageId, error: String(e) });
    });
  }
  log.info("template.rebuilt", { name, kind: recipe.source.kind });
  return { ref: `${host.prefix}-template:${name}`, name };
}
