import { z } from "zod";

import { buildBaseTemplate, deleteTemplate, listTemplates, promoteSnapshot } from "../services/templates";
import { defineOperation } from "./define";
import { BuildResultSchema, ImageSchema, OkSchema, PromotedTemplateSchema } from "./schemas";
import { snapshotRef, templateDescription, templateName, templateRef } from "./validation";

export const templateList = defineOperation({
  name: "template.list",
  tag: "templates",
  summary: "List templates",
  kind: "read",
  scope: "template:read",
  async: false,
  input: z.object({}),
  output: z.object({ templates: z.array(ImageSchema), baseTemplate: z.string() }),
  rest: [{ method: "GET", path: "/api/templates" }],
  cli: "template list",
  run: async ({ host }) => ({ templates: await listTemplates(host), baseTemplate: host.baseTemplateTag }),
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
  run: async ({ host }, input) => ({
    template: await promoteSnapshot(host, input.ref, input.name, input.description),
  }),
});

export const templateBuild = defineOperation({
  name: "template.build",
  tag: "templates",
  summary: "Build the bundled base template",
  kind: "write",
  scope: "template:write",
  async: false,
  input: z.object({}),
  output: BuildResultSchema,
  rest: [{ method: "POST", path: "/api/templates/base/build" }],
  cli: "template build",
  resolve: async ({ host }) => ({ ref: host.baseTemplateTag }),
  activity: { action: () => "template.build", target: (_input, base) => base.ref },
  audit: { target: (_input, base) => base && { kind: "template", name: base.ref } },
  run: ({ host }) => buildBaseTemplate(host),
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

export const templateOperations = [templateList, templatePromote, templateBuild, templateDelete];
