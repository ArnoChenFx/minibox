import * as snapshots from "../docker/snapshots";
import * as templates from "../docker/templates";
import { json, readJson } from "../lib/http";
import { asObject, parseCreateBox, validateName } from "../lib/validation";
import { createBoxFrom, DEFAULT_RESOURCES, tracked } from "./boxes";
import { type Route, route } from "./router";

export const imageRoutes: Route[] = [
  route("GET", "/api/snapshots", async ({ app }) => json({ snapshots: await snapshots.listSnapshots(app.docker) })),
  route("DELETE", "/api/snapshots/:ref", async ({ app, params }) => {
    const ref = params.ref ?? "";
    await tracked(app, "snapshot.delete", ref, () => snapshots.deleteSnapshot(app.docker, ref));
    return json({ ok: true });
  }),
  route("POST", "/api/snapshots/:ref/boxes", async ({ app, params, req }) => {
    const ref = params.ref ?? "";
    const input = parseCreateBox({ ...asObject(await readJson(req)), template: ref }, DEFAULT_RESOURCES);
    return json({ box: await createBoxFrom(app, input, `snapshot:${ref}`) }, 201);
  }),
  route("POST", "/api/snapshots/:ref/promote", async ({ app, params, req }) => {
    const ref = params.ref ?? "";
    const body = asObject(await readJson(req));
    const name = validateName(body.name, "name", "模板名称");
    const description = typeof body.description === "string" ? body.description.slice(0, 200) : undefined;
    return json(
      {
        template: await tracked(app, "template.promote", name, () =>
          templates.promoteSnapshot(app.docker, ref, name, description),
        ),
      },
      201,
    );
  }),
  route("GET", "/api/templates", async ({ app }) =>
    json({ templates: await templates.listTemplates(app.docker), baseTemplate: app.cfg.baseTemplateTag }),
  ),
  route("POST", "/api/templates/base/build", async ({ app }) =>
    json(await tracked(app, "template.build", app.cfg.baseTemplateTag, () => templates.buildBaseTemplate(app.docker))),
  ),
  route("DELETE", "/api/templates/:ref", async ({ app, params }) => {
    const ref = params.ref ?? "";
    await tracked(app, "template.delete", ref, () => templates.deleteTemplate(app.docker, ref));
    return json({ ok: true });
  }),
];
