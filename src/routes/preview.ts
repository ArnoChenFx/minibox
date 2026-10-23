import { AppError } from "../lib/errors";
import { json } from "../lib/http";
import { msg } from "../lib/messages";
import { boxLabel, previewHostname } from "../preview/domain";
import { TICKET_PARAM } from "../preview/grants";
import { runPreviewSelfCheck } from "../preview/selfcheck";
import { hostOfSpecRef, locateBox } from "../services/boxes";
import { assertPort } from "../services/ports";
import { type Route, route } from "./router";

/**
 * Opens a box port on its own preview host. A browser navigates here from the console, so only the session cookie may
 * open it: a Bearer credential is not read. The response is a redirect that carries a one-time ticket to the preview.
 */
const launchPreview = route(
  "GET",
  "/api/boxes/:id/ports/:port/preview",
  async ({ app, params, caller }) => {
    if (!caller?.sessionId) throw new AppError(401, "unauthorized", msg("preview_unauthorized"));
    const base = app.cfg.previewBaseDomain;
    if (base === null) throw new AppError(404, "not_found", msg("preview_subdomain_off"));
    const port = assertPort(Number(params.port));
    const ref = params.id ?? "";
    const named = hostOfSpecRef(app.hosts, ref);
    if (named && named.host.transport !== "local") {
      throw new AppError(501, "unsupported", msg("preview_agent_unsupported"));
    }
    const { box } = await locateBox(app.hosts, ref);
    if (!box.running && !box.sleeping) throw new AppError(409, "conflict", msg("preview_box_stopped"));
    const hostname = previewHostname(port, boxLabel(box.name, box.boxId), base);
    const ticket = app.previewGrants.issueTicket({ hostname, boxId: box.boxId, port }, caller.sessionId);
    return new Response(null, {
      status: 302,
      headers: {
        location: `https://${hostname}/?${TICKET_PARAM}=${ticket}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  },
  { public: true },
);

/** The preview setup the settings page shows. Path mode has nothing to check; subdomain mode runs the self-check. */
const previewSetup = route("GET", "/api/preview/setup", async ({ app, url }) => {
  const base = app.cfg.previewBaseDomain;
  if (base === null) return json({ mode: "path", baseDomain: null, checks: [] });
  const checks = await runPreviewSelfCheck({ base, consoleHost: url.hostname, probe: app.previewProbe });
  return json({ mode: "subdomain", baseDomain: base, checks });
});

export const previewRoutes: Route[] = [launchPreview, previewSetup];
