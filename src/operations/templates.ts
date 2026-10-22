import { z } from "zod";

import { assertNoSecretInImage } from "../secrets/env";
import { getBox } from "../services/boxes";
import { createDeclaredTemplate, declaredTemplate, rebuildDeclaredTemplate } from "../services/template-builds";
import {
  assertTemplateNameAvailable,
  buildBaseTemplate,
  holdingTemplateName,
  deleteTemplate,
  listTemplates,
  promoteSnapshot,
  saveBoxAsTemplate,
} from "../services/templates";
import { templateVisible } from "../tokens/model";
import { defineOperation } from "./define";
import { hostOfBox, localOnly } from "./routing";
import { BuildResultSchema, OkSchema, PromotedTemplateSchema, TemplateSchema } from "./schemas";
import { boxId, snapshotRef, templateDescription, templateName, templateRef, templateSource } from "./validation";

export const templateList = defineOperation({
  name: "template.list",
  tag: "templates",
  summary: "List templates",
  kind: "read",
  scope: "template:read",
  async: false,
  input: z.object({}),
  output: z.object({ templates: z.array(TemplateSchema), baseTemplate: z.string() }),
  rest: [{ method: "GET", path: "/api/templates" }],
  cli: "template list",
  run: async ({ host, principal }) => {
    const templates = await listTemplates(host);
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
  input: z.object({ ref: snapshotRef(), name: templateName(), description: templateDescription() }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/snapshots/:ref/promote", body: true, status: 201 }],
  cli: "template promote",
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
  precondition: async ({ host }) => localOnly(host, "templates"),
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
  input: z.object({ name: templateName(), description: templateDescription(), source: templateSource() }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/templates", body: true, status: 202 }],
  cli: "template create",
  mcp: {
    toolset: "tools",
    name: "create_template",
    description:
      "Build a template in the background from a source: kind dockerfile with text, git with url (and optional branch, subdir, dockerfile, secretRef), context with url of a .tar or .tar.gz (and optional dockerfile), or devcontainer with url of a repository (and optional branch, path, secretRef) whose devcontainer.json names an image or a build. containerEnv is kept, and any other devcontainer.json setting is refused. Owner only. Returns a task id; the task log shows the build.",
  },
  precondition: async ({ host }) => localOnly(host, "templates"),
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

export const templateRebuild = defineOperation({
  name: "template.rebuild",
  tag: "templates",
  summary: "Rebuild a template from the source it was built from",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({ ref: templateRef() }),
  output: z.object({ template: PromotedTemplateSchema }),
  rest: [{ method: "POST", path: "/api/templates/:ref/rebuild", status: 202 }],
  cli: "template rebuild",
  mcp: {
    toolset: "tools",
    name: "rebuild_template",
    description:
      "Rebuild a template from the source it was built from, so a branch or an archive gives its newest content. The tag moves only when the build succeeds, and a failed rebuild keeps the image the template had. Owner only. Returns a task id.",
  },
  precondition: async ({ host }) => localOnly(host, "templates"),
  resolve: ({ host }, input) => declaredTemplate(host, input.ref),
  exclusive: ({ host }, _input, declared) => `template.name:${host.host.id}:${declared.name}`,
  subject: (_input, declared) => declared.name,
  activity: { action: () => "template.rebuild", target: (_input, declared) => declared.name },
  audit: { target: (_input, declared) => declared && { kind: "template", name: declared.name } },
  run: async ({ host, task }, _input, declared) => ({
    template: await rebuildDeclaredTemplate(host, declared, { log: (text) => task?.log(text), signal: task?.signal }),
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
  input: z.object({}),
  output: BuildResultSchema,
  rest: [{ method: "POST", path: "/api/templates/base/build", status: 202 }],
  cli: "template build",
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

export const templateDelete = defineOperation({
  name: "template.delete",
  tag: "templates",
  summary: "Delete a template",
  kind: "destructive",
  scope: "template:delete",
  async: false,
  input: z.object({ ref: templateRef() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/templates/:ref" }],
  cli: "template rm",
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
  templateCreate,
  templateRebuild,
  templateBuild,
  templateDelete,
];
