import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";

import { msg, type Msg } from "../lib/messages";

const PROBE_TIMEOUT_MS = 5000;

export type ProbeAnswer =
  | { readonly ok: true; readonly status: number; readonly marked: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The network the self-check asks. The console runs the real one from its own host; tests pass a stub, so the checks
 * run without DNS or a server.
 */
export interface PreviewProbe {
  resolves(hostname: string): Promise<boolean>;
  get(url: string): Promise<ProbeAnswer>;
}

export const systemProbe: PreviewProbe = {
  async resolves(hostname) {
    try {
      await lookup(hostname);
      return true;
    } catch {
      return false;
    }
  },
  async get(url) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.body?.cancel();
      return { ok: true, status: res.status, marked: res.headers.get("x-minibox-preview") === "1" };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
};

type PreviewCheckId = "console" | "same_site" | "dns" | "https";

export interface PreviewCheck {
  readonly id: PreviewCheckId;
  readonly status: "ok" | "warn" | "error";
  readonly message: Msg;
}

export interface PreviewSelfCheckInput {
  readonly base: string;
  /** The hostname the console was reached on, from the request that asks. */
  readonly consoleHost: string;
  readonly probe: PreviewProbe;
}

/**
 * Checks that PREVIEW_BASE_DOMAIN is set up the way subdomain previews need: the console is outside the base domain,
 * the console and the previews do not share a registrable domain, a random name under the base resolves, and it answers
 * over HTTPS from MiniBox itself with MiniBox's marker, which proves a wildcard route reaches this server.
 */
export async function runPreviewSelfCheck(input: PreviewSelfCheckInput): Promise<PreviewCheck[]> {
  const { base, probe } = input;
  const consoleName = input.consoleHost.toLowerCase();
  const checks: PreviewCheck[] = [];

  const inBase = consoleName === base || consoleName.endsWith(`.${base}`);
  checks.push(
    inBase
      ? { id: "console", status: "error", message: msg("preview_check_console_in_base", { host: consoleName, base }) }
      : { id: "console", status: "ok", message: msg("preview_check_console_ok") },
  );

  const sameSite = registrableOf(consoleName) === registrableOf(base);
  checks.push(
    sameSite
      ? { id: "same_site", status: "warn", message: msg("preview_check_same_site", { base }) }
      : { id: "same_site", status: "ok", message: msg("preview_check_same_site_ok") },
  );

  const probeHost = `minibox-probe-${randomBytes(6).toString("hex")}.${base}`;
  const resolves = await probe.resolves(probeHost);
  checks.push(
    resolves
      ? { id: "dns", status: "ok", message: msg("preview_check_dns_ok") }
      : { id: "dns", status: "error", message: msg("preview_check_dns", { host: probeHost, base }) },
  );

  const answer = await probe.get(`https://${probeHost}/`);
  if (!answer.ok) {
    checks.push({
      id: "https",
      status: "error",
      message: msg("preview_check_https", { host: probeHost, base, detail: answer.reason }),
    });
  } else if (!answer.marked) {
    checks.push({
      id: "https",
      status: "error",
      message: msg("preview_check_other_server", { host: probeHost, base }),
    });
  } else {
    checks.push({ id: "https", status: "ok", message: msg("preview_check_ok") });
  }
  return checks;
}

/** The last two labels. An approximation of the registrable domain, which is enough to spot a shared parent. */
function registrableOf(host: string): string {
  return host.split(".").slice(-2).join(".");
}
