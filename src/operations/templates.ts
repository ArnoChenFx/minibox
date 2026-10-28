import { z } from "zod";

import type { HostCtx } from "../host/registry";
import { type ErrorCode, AppError, notFound } from "../lib/errors";
import { type MessageKey, msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import { assertNoSecretInImage } from "../secrets/env";
import { getBox } from "../services/boxes";
import { OFFICIAL_TEMPLATES, officialOfRef } from "../services/official-templates";
import {
  createDeclaredTemplate,
  declaredTemplate,
  rebuildDeclaredTemplate,
  type TemplateRecipe,
  templateAndRecipe,
} from "../services/template-builds";
import { copyTemplate, findTemplateSource, heldImage } from "../services/template-sync";
import {
  assertTemplateNameAvailable,
  buildBaseTemplate,
  deleteTemplate,
  editTemplate,
  forkTemplate,
  holdingTemplate,
  holdingTemplateName,
  listTemplates,
  promoteSnapshot,
  saveBoxAsTemplate,
  templateSourceImage,
} from "../services/templates";
import type { TaskError, TaskReader } from "../tasks/types";
import { templateVisible } from "../tokens/model";
import { defineOperation } from "./define";
import { fromEveryHost, hostById, hostNamed, hostOfBox, hostOfImage, imageHosts, refuseAgent } from "./routing";
import {
  BuildResultSchema,
  EditedTemplateSchema,
  OfficialTemplateSchema,
  OkSchema,
  PromotedTemplateSchema,
  TemplateRecipeSchema,
  TemplateSchema,
  TemplateSyncedSchema,
} from "./schemas";
import type { Operation, OperationContext } from "./types";
import {
  addFailure,
  boxId,
  hostId,
  officialName,
  snapshotRef,
  templateDescription,
  templateName,
  templateRef,
  templateSource,
} from "./validation";

export const templateList = defineOperation({
  name: "template.list",
  tag: "templates",
  summary: "List templates",
  kind: "read",
  scope: "template:read",
  async: false,
  input: z.object({ host: hostId().optional() }),
  output: z.object({ templates: z.array(TemplateSchema), baseTemplate: z.string() }),
  rest: [{ method: "GET", path: "/api/templates", query: ["host"] }],
  cli: "template list",
  mcp: {
    toolset: "tools",
    name: "list_templates",
    description:
      "List the templates on every host, each with the hostId that holds it, so a template present on one host and missing from another shows. A template built from a devcontainer.json also names its setup: postCreate as the command a created box runs once, and forwardPorts as the TCP ports it opens. Pass host to list one host. Returns the base template's tag too.",
  },
  run: async (ctx, input) => {
    const { principal, host } = ctx;
    const templates = await fromEveryHost(imageHosts(ctx, input.host), async (on) =>
      (await listTemplates(on)).map((image) => ({ ...image, hostId: on.host.id })),
    );
    return {
      templates: templates.filter((image) => templateVisible(principal, image)),
      baseTemplate: host.baseTemplateTag,
    };
  },
});

export const templatePromote = defineOperation({
  name: "template.promote",
  tag: "templates",
  summary: "Promote a snapshot to a template",
  kind: "write",
  scope: "template:write",
  async: false,
  input: z.object({
    ref: snapshotRef(),
    name: templateName(),
    description: templateDescription(),
    host: hostId().optional(),
  }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/snapshots/:ref/promote", body: true, status: 201 }],
  cli: "template promote",
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  activity: { action: () => "template.promote", target: ({ name }) => name },
  audit: { target: ({ name }) => ({ kind: "template", name }) },
  run: async ({ host, principal }, input) => ({
    template: await promoteSnapshot(host, input.ref, input.name, input.description, principal.id),
  }),
});

export const templateSave = defineOperation({
  name: "template.save",
  tag: "templates",
  summary: "Save a box as a template",
  kind: "write",
  scope: "template:write",
  async: true,
  conflicts: true,
  input: z.object({ id: boxId(), name: templateName(), description: templateDescription() }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/template", body: true, status: 202 }],
  cli: "template save",
  mcp: {
    toolset: "tools",
    name: "save_template",
    description:
      "Save a box as a template: the packages it installed and the system files it changed. /workspace and home volumes are not included, so use a checkpoint for data. Long-running; returns a task id.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async ({ host }, input, box) => {
    assertNoSecretInImage(host.specs.read(box.boxId)?.env ?? []);
    await assertTemplateNameAvailable(host, input.name);
  },
  exclusive: ({ host }, _input, box) => `template.save:${host.host.id}:${box.boxId}`,
  activity: { action: () => "template.save", target: (_input, box) => box.name },
  audit: { target: (input) => ({ kind: "template", name: input.name }) },
  run: async ({ host, principal, task }, input, box) => ({
    template: await saveBoxAsTemplate(host, box.boxId, input, principal.id, task),
  }),
});

/** The audit record names where a template comes from, and gives the size of a pasted Dockerfile, never its text. */
function sourceDetail(source: { kind: string; text?: string }): Record<string, unknown> {
  const { text, ...rest } = source;
  return text === undefined ? rest : { ...rest, bytes: text.length };
}

export const templateCreate = defineOperation({
  name: "template.create",
  tag: "templates",
  summary: "Build a template from a Dockerfile, a repository, a build context or a devcontainer.json",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({
    name: templateName(),
    description: templateDescription(),
    source: templateSource(),
    host: hostId().optional().meta({ description: "Host to build the template on. Omitted, the local host." }),
  }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/templates", body: true, status: 202 }],
  cli: "template create",
  mcp: {
    toolset: "tools",
    name: "create_template",
    description:
      "Build a template in the background from a source: kind dockerfile with text, git with url (and optional branch, subdir, dockerfile, secretRef), context with url of a .tar or .tar.gz (and optional dockerfile), or devcontainer with url of a repository (and optional branch, path, secretRef) whose devcontainer.json names an image or a build. containerEnv and remoteEnv are set in the image, and postCreateCommand and forwardPorts are stored with the template. Any other devcontainer.json setting is listed as a warning in the task log and not applied. Optional host builds on that host, default local. Owner only. Returns a task id; the task log shows the build.",
  },
  hostFor: (ctx, input) => hostNamed(ctx, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  beforeTask: async ({ host }, input) => assertTemplateNameAvailable(host, input.name),
  exclusive: ({ host }, input) => `template.name:${host.host.id}:${input.name}`,
  subject: (input) => input.name,
  activity: { action: () => "template.create", target: (input) => input.name },
  audit: {
    target: (input) => ({ kind: "template", name: input.name }),
    detail: (input) => ({ name: input.name, source: sourceDetail(input.source) }),
  },
  // A save or a promotion holds the name the same way, so a build that runs for minutes cannot retag over one of them.
  run: async ({ host, principal, task }, input) => ({
    template: await holdingTemplateName(host, input.name, () =>
      createDeclaredTemplate(
        host,
        { name: input.name, description: input.description, source: input.source, createdBy: principal.id },
        { log: (text) => task?.log(text), signal: task?.signal },
      ),
    ),
  }),
});

export const templateFork = defineOperation({
  name: "template.fork",
  tag: "templates",
  summary: "Fork a template into a new one that can be changed on its own",
  kind: "write",
  scope: "template:write",
  async: false,
  conflicts: true,
  input: z.object({
    ref: templateRef(),
    name: templateName(),
    description: templateDescription(),
    host: hostId()
      .optional()
      .meta({ description: "Host that holds the template to fork. Omitted, the first host that holds it." }),
  }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/templates/:ref/fork", body: true, query: ["host"], status: 201 }],
  cli: "template fork",
  mcp: {
    toolset: "tools",
    name: "fork_template",
    description:
      "Fork a template: copy its image and its description under a new name, so the copy can be changed on its own while the original stays as it is. A template built from a Dockerfile, a repository, a build context or a devcontainer.json brings its recipe along, pointed at the new image, so rebuild_template rebuilds the fork from the same source and the fork's boxes keep the fork's postCreateCommand and forwardPorts. A template saved from a box forks too, and its fork cannot be rebuilt. Optional description replaces the one copied. Optional host names the host that holds the template; without it the first host that holds it. Owner only. Returns the new template's ref and name.",
  },
  hostFor: async (ctx, input) => {
    // A bare name is a template on a host, so the host that holds it is looked for under its tag too.
    if (input.host === undefined && NAME_RE.test(input.ref) && !input.ref.includes(":")) {
      const found = await hostOfImage(ctx, `${ctx.host.prefix}-template:${input.ref}`);
      if (found.host.id !== ctx.host.host.id) return found;
    }
    return hostOfImage(ctx, input.ref, input.host);
  },
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: ({ host }, input) => templateSourceImage(host, input.ref),
  beforeTask: async ({ host }, input) => assertTemplateNameAvailable(host, input.name),
  activity: { action: () => "template.fork", target: (input) => input.name },
  audit: {
    target: (input) => ({ kind: "template", name: input.name }),
    detail: (input, source) => ({ name: input.name, from: source?.ref }),
  },
  run: async ({ host, principal }, input, source) => ({
    template: await holdingTemplateName(host, input.name, () =>
      forkTemplate(host, source, { name: input.name, description: input.description, createdBy: principal.id }),
    ),
  }),
});

/**
 * The setup a template edit sets: a `postCreateCommand` and the `forwardPorts` a box created from the template gets. A
 * field the edit leaves out keeps the value the template has, so an edit that only sets the ports keeps its command;
 * `init: null` or an empty object clears both. `init` is read from the same body the build takes, so a client sends the
 * shape it already knows.
 */
const templateInitInput = () =>
  z
    .object({
      postCreate: z
        .array(z.string())
        .optional()
        .meta({ description: "postCreateCommand as argv, or as /bin/sh -c <text>." }),
      forwardPorts: z
        .array(z.number().int().min(1).max(65535))
        .optional()
        .meta({ description: "TCP ports a box created from the template opens as manual preview ports." }),
    })
    .nullable()
    .optional()
    .meta({
      description:
        "The setup a box created from the template gets. Omitted keeps the setup the template has, and a field left out keeps that field, so sending only forwardPorts keeps the template's postCreate. null or an empty object clears the whole setup. postCreate is the command as argv, forwardPorts the TCP ports to open.",
    });

/**
 * The source a template rebuilds from, so the console can prefill its edit dialog. Only a declared template has one; a
 * template saved from a box answers `400 template_not_declared`, as a rebuild does, because there is nothing to edit.
 */
export const templateGet = defineOperation({
  name: "template.get",
  tag: "templates",
  summary: "Read the source a template rebuilds from",
  kind: "read",
  scope: "template:read",
  async: false,
  input: z.object({
    ref: templateRef(),
    host: hostId()
      .optional()
      .meta({ description: "Host that holds the template. Omitted, the first host that holds it." }),
  }),
  output: z.object({ recipe: TemplateRecipeSchema }),
  rest: [{ method: "GET", path: "/api/templates/:ref/recipe", query: ["host"] }],
  cli: "template get",
  mcp: {
    toolset: "tools",
    name: "get_template_source",
    description:
      "Read the source a template rebuilds from: its kind, the fields of that source (the Dockerfile text for a dockerfile, the url and optional branch, subdir, path, dockerfile and secretRef for the others), and the setup a box created from it gets. A template saved from a box has no source, so it answers 400 template_not_declared. Optional host names the host that holds the template; without it the first host that holds it. Returns the recipe.",
  },
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: ({ host }, input) => templateAndRecipe(host, input.ref),
  run: async (_ctx, _input, [declared]) => ({ recipe: recipeView(declared.recipe) }),
});

/** The recipe as `template.get` answers it: the source's fields, and the setup the template asks for. */
function recipeView(recipe: TemplateRecipe): z.input<typeof TemplateRecipeSchema> {
  const { source } = recipe;
  return {
    buildKind: source.kind,
    source: {
      kind: source.kind,
      ...(source.kind === "dockerfile" ? { text: source.text } : {}),
      ...(source.kind === "git" || source.kind === "context" || source.kind === "devcontainer"
        ? { url: source.url }
        : {}),
      ...(source.kind === "git" || source.kind === "devcontainer" ? { branch: source.branch } : {}),
      ...(source.kind === "git" ? { subdir: source.subdir } : {}),
      ...(source.kind === "devcontainer" ? { path: source.path } : {}),
      ...(source.kind === "git" || source.kind === "context" ? { dockerfile: source.dockerfile } : {}),
      ...(source.kind === "git" || source.kind === "devcontainer" ? { secretRef: source.secretRef } : {}),
      ...(source.kind === "official" ? { name: source.name } : {}),
    },
    ...(recipe.init?.postCreate === undefined ? {} : { postCreate: recipe.init.postCreate }),
    ...(recipe.init?.forwardPorts === undefined ? {} : { forwardPorts: recipe.init.forwardPorts }),
  };
}

export const templateEdit = defineOperation({
  name: "template.edit",
  tag: "templates",
  summary: "Edit the source a template rebuilds from, without building it",
  kind: "write",
  scope: "template:write",
  async: false,
  conflicts: true,
  input: z
    .object({
      ref: templateRef(),
      description: templateDescription(),
      source: templateSource().optional(),
      init: templateInitInput(),
      host: hostId()
        .optional()
        .meta({ description: "Host that holds the template. Omitted, the first host that holds it." }),
    })
    .superRefine((input, ctx) => {
      if (input.source === undefined && input.init === undefined && input.description === undefined) {
        addFailure(ctx, { message: msg("template_edit_empty"), field: "source" });
      }
    }),
  output: z.object({ template: EditedTemplateSchema }),
  rest: [{ method: "PATCH", path: "/api/templates/:ref", body: true, query: ["host"] }],
  cli: "template edit",
  mcp: {
    toolset: "tools",
    name: "edit_template",
    description:
      "Change what a template rebuilds from without building it: its source, the setup a box created from it gets, and its description. The template's current image is kept, so boxes created before the next rebuild are unaffected; rebuild_template then builds the edited source. A template built from a Dockerfile, a repository, a build context or a devcontainer.json can be edited, and a template saved from a box cannot, because it has no source to build from. A new description re-commits the image under the same tag, so its card shows the new one. Omitted source, init and description fields keep the values the template has; init null clears the setup. Optional host names the host that holds the template; without it the first host that holds it. A token may edit a template it can use, which needs the tool:install scope, as template writes do. Returns the template's ref, name and build kind.",
  },
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: ({ host }, input) => templateAndRecipe(host, input.ref),
  activity: { action: () => "template.edit", target: (_input, resolved) => resolved[0].name },
  audit: {
    target: (_input, resolved) => resolved && { kind: "template", name: resolved[0].name },
    // The source's text is a Dockerfile, so only its size is recorded, as a create records it.
    detail: (input) => ({
      name: input.ref,
      description: input.description,
      source: input.source === undefined ? undefined : sourceDetail(input.source),
      init: input.init,
    }),
  },
  run: async ({ host }, _input, [declared, image]) => ({
    template: await holdingTemplate(host, declared.name, () =>
      editTemplate(host, declared, image, {
        source: _input.source,
        init: _input.init,
        description: _input.description,
      }),
    ),
  }),
});

export const templateRebuild = defineOperation({
  name: "template.rebuild",
  tag: "templates",
  summary: "Rebuild a template from the source it was built from",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({
    ref: templateRef(),
    host: hostId()
      .optional()
      .meta({ description: "Host that holds the template. Omitted, the first host that holds it." }),
  }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/templates/:ref/rebuild", query: ["host"], status: 202 }],
  cli: "template rebuild",
  mcp: {
    toolset: "tools",
    name: "rebuild_template",
    description:
      "Rebuild a template from the source it was built from, so a branch or an archive gives its newest content. The tag moves only when the build succeeds, and a failed rebuild keeps the image the template had. Owner only. Returns a task id.",
  },
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: ({ host }, input) => declaredTemplate(host, input.ref),
  exclusive: ({ host }, _input, declared) => `template.name:${host.host.id}:${declared.name}`,
  subject: (_input, declared) => declared.name,
  activity: { action: () => "template.rebuild", target: (_input, declared) => declared.name },
  audit: { target: (_input, declared) => declared && { kind: "template", name: declared.name } },
  // A rebuild reads the recipe and writes it back when it ends, so an edit that lands while it runs would be overwritten.
  // Holding the name for the whole build makes such an edit answer `409 template_busy` instead, as it does beside a save.
  run: async ({ host, task }, _input, declared) => ({
    template: await holdingTemplate(host, declared.name, () =>
      rebuildDeclaredTemplate(host, declared, { log: (text) => task?.log(text), signal: task?.signal }),
    ),
  }),
});

export const templateBuild = defineOperation({
  name: "template.build",
  tag: "templates",
  summary: "Build the bundled base template",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({ host: hostId().optional() }),
  output: BuildResultSchema,
  rest: [{ method: "POST", path: "/api/templates/base/build", query: ["host"], status: 202 }],
  cli: "template build",
  hostFor: (ctx, input) => hostNamed(ctx, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: async ({ host }) => ({ ref: host.baseTemplateTag }),
  exclusive: ({ host }) => `template.build:${host.host.id}`,
  subject: () => "base",
  activity: { action: () => "template.build", target: (_input, base) => base.ref },
  audit: { target: (_input, base) => base && { kind: "template", name: base.ref } },
  run: async ({ host, task }) => {
    const built = await buildBaseTemplate(host, task);
    return { ref: built.ref };
  },
});

export const templateSync = defineOperation({
  name: "template.sync",
  tag: "templates",
  summary: "Copy a template to another host",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({
    ref: templateRef(),
    host: hostId().meta({ description: "The host to copy the template to." }),
  }),
  output: TemplateSyncedSchema,
  rest: [{ method: "POST", path: "/api/templates/:ref/sync", body: true, status: 202 }],
  cli: "template sync",
  mcp: {
    toolset: "tools",
    name: "sync_template",
    description:
      "Copy a template from a host that holds it to another host, so a box can be created there. The image keeps its id, and is not sent again when the target already holds it. A declared template's recipe is copied too, so its setup and rebuild come along. Owner only. Returns a task id; the task log shows the transfer.",
  },
  hostFor: (ctx, input) => hostById(ctx, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  resolve: async (ctx, input) => {
    const others = imageHosts(ctx).filter((candidate) => candidate.host.id !== ctx.host.host.id);
    const source = await findTemplateSource(others, input.ref);
    if (!source) throw notFound(msg("template_not_found"));
    return source;
  },
  exclusive: ({ host }, input) => `template.sync:${host.host.id}:${input.ref}`,
  subject: (input) => input.ref,
  activity: { action: () => "template.sync", target: (input) => input.ref },
  audit: { target: (input) => ({ kind: "template", name: input.ref }) },
  run: async ({ host, task }, input, source) => ({
    ref: input.ref,
    host: host.host.id,
    sent: await copyTemplate(source, host, input.ref, task),
  }),
});

export const templateOfficialList = defineOperation({
  name: "template.official.list",
  tag: "templates",
  summary: "List the official templates",
  kind: "read",
  scope: "template:official",
  async: false,
  input: z.object({}),
  output: z.object({ templates: z.array(OfficialTemplateSchema) }),
  rest: [{ method: "GET", path: "/api/templates/official" }],
  mcp: {
    toolset: "tools",
    name: "list_official_templates",
    description:
      "List the official templates MiniBox ships: node, python, go and minimal. Each has its description, the pinned base image it builds from, and the ref it has on this host. A template is built on a host when a box first needs it there, or by build_official_template.",
  },
  run: async ({ host }) => ({
    templates: OFFICIAL_TEMPLATES.map((template) => ({
      name: template.name,
      ref: `${host.prefix}-template:${template.name}`,
      description: template.description,
      base: template.base,
    })),
  }),
});

export const templateOfficialBuild = defineOperation({
  name: "template.official.build",
  tag: "templates",
  summary: "Build an official template",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({
    name: officialName(),
    host: hostId().optional().meta({ description: "Host to build the template on. Omitted, the local host." }),
  }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/templates/official/:name/build", query: ["host"], status: 202 }],
  cli: "template build-official",
  mcp: {
    toolset: "tools",
    name: "build_official_template",
    description:
      "Build an official template (node, python, go or minimal) on a host, from the Dockerfile that ships with MiniBox. Its base image is pulled when the host lacks it. A name the host already holds is refused. Owner only. Returns a task id; the task log shows the build.",
  },
  hostFor: (ctx, input) => hostNamed(ctx, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  beforeTask: async ({ host }, input) => assertTemplateNameAvailable(host, input.name),
  exclusive: ({ host }, input) => `template.name:${host.host.id}:${input.name}`,
  subject: (input) => input.name,
  activity: { action: () => "template.official.build", target: (input) => input.name },
  audit: { target: (input) => ({ kind: "template", name: input.name }) },
  run: async ({ host, principal, task }, input) => ({
    template: await holdingTemplateName(host, input.name, () =>
      createDeclaredTemplate(
        host,
        { name: input.name, source: { kind: "official", name: input.name }, createdBy: principal.id },
        { log: (text) => task?.log(text), signal: task?.signal },
      ),
    ),
  }),
});

/**
 * Makes `ref` available on `host` before a box is created there. When `host` lacks it, a copy comes from another host
 * that holds it, and when none does, the base template or an official template is built on `host` from the Dockerfile
 * that ships with MiniBox. Either runs as a task of its own, and the create waits for it, so the box starts from the image it names. A
 * task already running for the same template is joined rather than started twice. Only an owner's create copies or
 * builds: a token's create is judged by the template its host shows it, as it always was.
 */
export async function ensureTemplateOn(
  ctx: OperationContext,
  host: HostCtx,
  ref: string,
): Promise<{ taskId: string } | undefined> {
  const { startTask, tasks } = ctx;
  if (ctx.principal.type !== "owner" || host.host.transport === "agent" || !startTask || !tasks) return undefined;
  if (await heldImage(host, ref)) return undefined;
  const others = imageHosts(ctx).filter((candidate) => candidate.host.id !== host.host.id);
  const source = await findTemplateSource(others, ref);
  if (source) return awaitTask(startTask, tasks, templateSync, { ref, host: host.host.id }, source, "copy");
  if (ref === host.baseTemplateTag)
    return awaitTask(startTask, tasks, templateBuild, {}, { ref: host.baseTemplateTag }, "build");
  const official = officialOfRef(host, ref);
  if (!official) return undefined;
  return awaitTask(startTask, tasks, templateOfficialBuild, { name: official.name }, undefined, "build");
}

/**
 * Runs `operation` as a child task and waits for it to finish. A run already going under the same key is joined rather
 * than started again, so the caller gets that run's outcome.
 */
async function awaitTask(
  startTask: NonNullable<OperationContext["startTask"]>,
  tasks: TaskReader,
  operation: Operation,
  input: Record<string, unknown>,
  resolved: unknown,
  what: "copy" | "build",
): Promise<{ taskId: string }> {
  let taskId: string;
  try {
    ({ taskId } = await startTask(operation, input, resolved));
  } catch (e) {
    const running = e instanceof AppError && e.key === "task_busy" ? runningTaskOf(e.details) : undefined;
    if (running === undefined) throw e;
    taskId = running;
  }
  await tasks.done(taskId);
  const finished = tasks.get(taskId, { output: false });
  if (finished?.status !== "succeeded") throw taskFailure(finished?.error, what);
  return { taskId };
}

/** The error a failed copy or build gives its create, with the task's own message key so the console can translate it. */
function taskFailure(error: TaskError | undefined, what: "copy" | "build"): AppError {
  if (!error)
    return new AppError(502, "docker_error", msg("docker_error", { detail: `the template ${what} did not finish` }));
  const message = error.key ? msg(error.key as MessageKey, error.params) : error.message;
  return new AppError(error.status, error.code as ErrorCode, message);
}

function runningTaskOf(details: unknown): string | undefined {
  const taskId = (details as { taskId?: unknown } | undefined)?.taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

export const templateDelete = defineOperation({
  name: "template.delete",
  tag: "templates",
  summary: "Delete a template",
  kind: "destructive",
  scope: "template:delete",
  async: false,
  input: z.object({
    ref: templateRef(),
    host: hostId()
      .optional()
      .meta({ description: "Host that holds the template. Omitted, the first host that holds it." }),
  }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/templates/:ref", query: ["host"] }],
  cli: "template rm",
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  activity: { action: () => "template.delete", target: ({ ref }) => ref },
  audit: { target: ({ ref }) => ({ kind: "template", name: ref }) },
  run: async ({ host }, input) => {
    await deleteTemplate(host, input.ref);
    return { ok: true as const };
  },
});

export const templateOperations = [
  templateList,
  templatePromote,
  templateSave,
  templateGet,
  templateCreate,
  templateFork,
  templateEdit,
  templateRebuild,
  templateBuild,
  templateSync,
  templateDelete,
  templateOfficialList,
  templateOfficialBuild,
];
