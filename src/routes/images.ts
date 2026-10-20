import { tracked } from "../activity";
import { json, readJson } from "../lib/http";
import { asObject, validateName } from "../lib/validation";
import * as snapshots from "../services/snapshots";
import * as templates from "../services/templates";
import { type Route, route } from "./router";

export const imageRoutes: Route[] = [
  route("GET", "/api/snapshots", async ({ host }) => json({ snapshots: await snapshots.listSnapshots(host) })),
  route("DELETE", "/api/snapshots/:ref", async ({ app, host, params }) => {
    const ref = params.ref ?? "";
    await tracked(app.activity, "snapshot.delete", ref, () => snapshots.deleteSnapshot(host, ref));
    return json({ ok: true });
  }),
  route("POST", "/api/snapshots/:ref/promote", async ({ app, host, params, req }) => {
    const ref = params.ref ?? "";
    const body = asObject(await readJson(req));
    const name = validateName(body.name, "name", "templateName");
    const description = typeof body.description === "string" ? body.description.slice(0, 200) : undefined;
    return json(
      {
        template: await tracked(app.activity, "template.promote", name, () =>
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
    json(await tracked(app.activity, "template.build", host.baseTemplateTag, () => templates.buildBaseTemplate(host))),
  ),
  route("DELETE", "/api/templates/:ref", async ({ app, host, params }) => {
    const ref = params.ref ?? "";
    await tracked(app.activity, "template.delete", ref, () => templates.deleteTemplate(host, ref));
    return json({ ok: true });
  }),
];
