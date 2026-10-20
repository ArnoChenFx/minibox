import { json, readJson } from "../lib/http";
import { asObject, parseCreateBox, validateDescription, validateName } from "../lib/validation";
import * as snapshots from "../services/snapshots";
import * as templates from "../services/templates";
import { createBoxFrom, DEFAULT_RESOURCES, tracked } from "./boxes";
import { type Route, route } from "./router";

export const imageRoutes: Route[] = [
  route("GET", "/api/snapshots", async ({ host }) => json({ snapshots: await snapshots.listSnapshots(host) })),
  route("DELETE", "/api/snapshots/:ref", async ({ app, host, params }) => {
    const ref = params.ref ?? "";
    await tracked(app, "snapshot.delete", ref, () => snapshots.deleteSnapshot(host, ref));
    return json({ ok: true });
  }),
  route("POST", "/api/snapshots/:ref/boxes", async ({ app, host, params, req }) => {
    const ref = params.ref ?? "";
    const input = parseCreateBox({ ...asObject(await readJson(req)), template: ref }, DEFAULT_RESOURCES);
    return json({ box: await createBoxFrom(app, host, input, `snapshot:${ref}`) }, 201);
  }),
  route("POST", "/api/snapshots/:ref/promote", async ({ app, host, params, req }) => {
    const ref = params.ref ?? "";
    const body = asObject(await readJson(req));
    const name = validateName(body.name, "name", "templateName");
    const description = validateDescription(body.description);
    return json(
      {
        template: await tracked(app, "template.promote", name, () =>
          templates.promoteSnapshot(host, ref, name, description),
        ),
      },
      201,
    );
  }),
  route("GET", "/api/templates", async ({ host }) =>
    json({ templates: await templates.listTemplates(host), baseTemplate: host.baseTemplateTag }),
  ),
  route("POST", "/api/templates/base/build", async ({ app, host }) =>
    json(await tracked(app, "template.build", host.baseTemplateTag, () => templates.buildBaseTemplate(host))),
  ),
  route("DELETE", "/api/templates/:ref", async ({ app, host, params }) => {
    const ref = params.ref ?? "";
    await tracked(app, "template.delete", ref, () => templates.deleteTemplate(host, ref));
    return json({ ok: true });
  }),
];
