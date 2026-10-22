import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DIR_MODE, writeFileAtomic } from "../data-dir";
import type { HostCtx } from "../host/registry";
import { DEVCONTAINER_PATHS, envInstructions, readDevcontainer } from "../lib/devcontainer";
import { badRequest, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { dockerfileProblem, resolveInside } from "../lib/source";
import { NAME_RE } from "../lib/validation";
import { type ImageDetails, isRuntimeError } from "../runtime";
import { assertDirIn, assertFileIn, extractContextUrl, pathParts } from "./build-context";
import { cloneInto, copyVolumeOut, ROOT_OWNER } from "./git-clone";

export const BUILD_KINDS = ["dockerfile", "git", "context", "devcontainer"] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

/** A devcontainer.json larger than this is refused unread, and so is a repository Dockerfile larger than it. */
const REPO_FILE_MAX_BYTES = 256 * 1024;

/**
 * Where a declared template's files come from. A Dockerfile is pasted in and kept in the recipe. The other kinds are
 * fetched on every build, so a rebuild picks up the newest commit or archive. Credentials are never stored here:
 * `secretRef` names a secret the clone reads when it runs.
 */
export type TemplateSource =
  | { kind: "dockerfile"; text: string }
  | { kind: "git"; url: string; branch?: string; subdir?: string; dockerfile?: string; secretRef?: string }
  | { kind: "context"; url: string; dockerfile?: string }
  | { kind: "devcontainer"; url: string; branch?: string; path?: string; secretRef?: string };

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
  return (BUILD_KINDS as readonly unknown[]).includes(value.kind);
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
  return recipe as TemplateRecipe;
}

function writeRecipe(host: HostCtx, name: string, recipe: TemplateRecipe): void {
  mkdirSync(recipesDir(host), { recursive: true, mode: DIR_MODE });
  writeFileAtomic(recipePath(host, name), `${JSON.stringify(recipe, null, 2)}\n`);
}

/** Forgets the recipe of a template name. A recipe whose image was removed by another tool is harmless and is replaced. */
export function removeRecipe(host: HostCtx, name: string): void {
  rmSync(recipePath(host, name), { force: true });
}

/** How a template was built, when its image still matches the recipe that built it. */
export function buildKindOf(host: HostCtx, name: string, imageId: string): BuildKind | null {
  if (!NAME_RE.test(name)) return null;
  const recipe = readRecipe(host, name);
  return recipe && recipe.imageId === imageId ? recipe.source.kind : null;
}

/** The declared template named by `ref`, which must be a template image this recipe built. */
export async function declaredTemplate(host: HostCtx, ref: string): Promise<DeclaredTemplate> {
  const prefix = `${host.prefix}-template:`;
  const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  if (!NAME_RE.test(name)) throw notFound(msg("template_not_found"));
  let image: ImageDetails;
  try {
    image = await host.runtime.inspectImage(ref);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) throw notFound(msg("template_not_found"));
    throw e;
  }
  if (image.labels[host.keys.template] !== "true") throw notFound(msg("template_not_found"));
  const recipe = readRecipe(host, name);
  if (!recipe || recipe.imageId !== image.id) throw badRequest(msg("template_not_declared", { name }));
  return { name, imageId: image.id, recipe };
}

/** The description a template gets when none is given, so the label is never empty. */
export function defaultDescription(source: TemplateSource): string {
  if (source.kind === "dockerfile") return "Built from a Dockerfile";
  if (source.kind === "git") return `Built from ${source.url}${source.branch ? ` (${source.branch})` : ""}`;
  if (source.kind === "devcontainer")
    return `Built from ${source.url}${source.branch ? ` (${source.branch})` : ""}, devcontainer.json`;
  return `Built from ${source.url}`;
}

interface BuildContext {
  contextDir: string;
  dockerfile: string;
  src: string[];
  args: Record<string, string>;
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

/**
 * Builds from the devcontainer.json of a cloned repository. An `image` becomes `FROM` in a Dockerfile of its own. A
 * `build` uses the repository's Dockerfile and context, both inside the repository and resolved from the file's directory.
 * containerEnv goes in as ENV instructions: for a `build`, in a copy of the Dockerfile that sits in the context, so the
 * repository's file is never changed.
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
  if ("problem" in reading) {
    throw badRequest(reading.problem, { field: "source" }, { hint: reading.hint });
  }
  const { plan } = reading;
  const configDir = configPath.split("/").slice(0, -1);
  if (plan.base.kind === "image") {
    const dir = join(work, "image");
    await mkdir(dir, { mode: 0o755 });
    await writeFile(join(dir, "Dockerfile"), `FROM ${plan.base.image}\n${envInstructions(plan.env)}`, { mode: 0o644 });
    return { contextDir: dir, dockerfile: "Dockerfile", src: ["Dockerfile"], args: {} };
  }
  const contextParts = resolveInside(configDir, plan.base.context);
  const dockerfileParts = resolveInside(configDir, plan.base.dockerfile);
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
  if (Object.keys(plan.env).length === 0) {
    return { contextDir, dockerfile, src: readdirSync(contextDir), args: plan.base.args };
  }
  const original = await readRepoFile(join(contextDir, dockerfile), REPO_FILE_MAX_BYTES, dockerfile);
  const copy = `.minibox-env-${randomBytes(6).toString("hex")}.Dockerfile`;
  const separator = original.endsWith("\n") ? "" : "\n";
  await writeFile(join(contextDir, copy), `${original}${separator}${envInstructions(plan.env)}`, { mode: 0o644 });
  return { contextDir, dockerfile: copy, src: readdirSync(contextDir), args: plan.base.args };
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

/** Builds `source` into the image `${prefix}-template:${name}` and returns the image, or throws with the tag untouched. */
async function buildImageFrom(
  host: HostCtx,
  build: { name: string; source: TemplateSource; description: string; createdBy: string; created: string },
  progress: BuildProgress,
): Promise<ImageDetails> {
  const tag = `${host.prefix}-template:${build.name}`;
  const work = await mkdtemp(join(tmpdir(), "minibox-template-"));
  try {
    const context = await materialize(host, build.source, work, progress);
    await host.runtime.buildImage({
      contextDir: context.contextDir,
      dockerfile: context.dockerfile,
      src: context.src,
      args: context.args,
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
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return host.runtime.inspectImage(tag);
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
  const image = await buildImageFrom(
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
  try {
    writeRecipe(host, input.name, {
      version: 1,
      imageId: image.id,
      description: input.description ?? null,
      createdBy: input.createdBy,
      created,
      source: input.source,
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
 */
export async function rebuildDeclaredTemplate(
  host: HostCtx,
  declared: DeclaredTemplate,
  progress: BuildProgress,
): Promise<{ ref: string; name: string }> {
  const { name, recipe } = declared;
  const created = new Date().toISOString();
  const image = await buildImageFrom(
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
  writeRecipe(host, name, { ...recipe, imageId: image.id, created });
  if (image.id !== declared.imageId) {
    await host.runtime.removeImage(declared.imageId, { force: false }).catch((e: unknown) => {
      log.warn("template.previous_image_kept", { name, image: declared.imageId, error: String(e) });
    });
  }
  log.info("template.rebuilt", { name, kind: recipe.source.kind });
  return { ref: `${host.prefix}-template:${name}`, name };
}
