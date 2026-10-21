import { json } from "../lib/http";
import { type Route, route, scopedAccess } from "./router";

/** The gateway's host key, which a client pins. The private half never leaves DATA_DIR. */
export const sshRoutes: Route[] = [
  route("GET", "/api/ssh/host-key", ({ app }) => json(app.ssh.hostKeyView()), {
    access: scopedAccess("box:ssh"),
  }),
];
