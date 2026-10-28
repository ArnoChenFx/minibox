import { api } from "./api.js";

/**
 * The version of the MiniBox this console talks to, read once from `GET /api/system` and shared: the sidebar shows it,
 * and the pairing command pins the agent image to it. Null until the read lands, and null again when it fails, so a
 * later read can try again.
 */
let version = null;
let reading = null;

export const systemVersion = () => version;

/** Reads the server's version, once. Never rejects: a console that cannot read it treats the version as unknown. */
export function readSystemVersion() {
  reading ??= api("/api/system")
    .then((system) => {
      version = typeof system?.version === "string" && system.version.trim() ? system.version.trim() : null;
      return version;
    })
    .catch(() => {
      reading = null;
      version = null;
      return null;
    });
  return reading;
}
