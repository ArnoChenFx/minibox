import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isSecureRequest, lastListValue } from "../auth";

export type InstallScript = "install.sh" | "install.ps1";

const ORIGIN_PLACEHOLDER = "__MINIBOX_ORIGIN__";
/** Only a plain scheme, host and port can be written into a script, so no quote or shell character gets through. */
const ORIGIN_SHAPE = /^https?:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

const TEMPLATES: Record<InstallScript, string> = {
  "install.sh": readFileSync(join(import.meta.dir, "install.sh"), "utf8"),
  "install.ps1": readFileSync(join(import.meta.dir, "install.ps1"), "utf8"),
};

/** The address MiniBox is reached at, as the request names it. Only an address in ALLOWED_ORIGINS is used as given. */
export function requestOrigin(
  req: Request,
  policy: { trustProxy: boolean; allowedOrigins: readonly string[] },
): string | null {
  const forwarded = policy.trustProxy ? lastListValue(req.headers.get("x-forwarded-host")) : null;
  const host = (forwarded ?? req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
  const allowed = policy.allowedOrigins.find((origin) => new URL(origin).host === host);
  const origin = allowed ?? `${isSecureRequest(req, policy.trustProxy) ? "https" : "http"}://${host}`;
  return ORIGIN_SHAPE.test(origin) ? origin : null;
}

/** The installer with the server's address filled in. Throws for an address that is not a plain origin. */
export function renderInstallScript(name: InstallScript, origin: string): string {
  if (!ORIGIN_SHAPE.test(origin)) throw new Error(`not a plain http(s) origin: ${origin}`);
  return TEMPLATES[name].replaceAll(ORIGIN_PLACEHOLDER, origin);
}
