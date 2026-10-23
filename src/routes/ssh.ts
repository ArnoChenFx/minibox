import type { App } from "../app";
import { json } from "../lib/http";
import { type Route, route, scopedAccess } from "./router";

/**
 * Where standard SSH clients reach the direct port, or null when it is off. `host` is null unless SSH_PUBLIC_HOST
 * names it; the console then shows the address it was opened at.
 */
export function directSshView(app: App): { host: string | null; port: number } | null {
  const port = app.sshDirect?.port ?? null;
  if (port === null) return null;
  return { host: app.cfg.sshPublicHost, port: app.cfg.sshPublicPort ?? port };
}

/** The gateway's host key, which a client pins, and the direct SSH address. The private half never leaves DATA_DIR. */
export const sshRoutes: Route[] = [
  route("GET", "/api/ssh/host-key", ({ app }) => json({ ...app.ssh.hostKeyView(), direct: directSshView(app) }), {
    access: scopedAccess("box:ssh"),
  }),
];
