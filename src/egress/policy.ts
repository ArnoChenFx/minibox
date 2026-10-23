import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * `open` is the default: the box reaches the internet like any container. `none` gives the box an internal network with
 * no route out. `proxy-only` also gives it an internal network, but the box's only reachable peer there is its proxy,
 * which forwards to the hosts on the allowlist.
 */
export const EGRESS_MODES = ["open", "none", "proxy-only"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

export const EGRESS_PRESETS = ["agent-default", "package-registries"] as const;
export type EgressPreset = (typeof EGRESS_PRESETS)[number];

const PRESET_DOMAINS: Readonly<Record<EgressPreset, readonly string[]>> = {
  "agent-default": [
    "api.anthropic.com",
    "api.openai.com",
    "auth.openai.com",
    "chatgpt.com",
    "generativelanguage.googleapis.com",
    "api2.cursor.sh",
  ],
  "package-registries": [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "rubygems.org",
    "repo.maven.apache.org",
    "repo1.maven.org",
    "deb.debian.org",
    "security.debian.org",
  ],
};

export const MAX_EGRESS_DOMAINS = 100;
const MAX_HOST_LENGTH = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What a create or rebuild asks for. Presets and domains apply to `proxy-only` only. */
export interface EgressRequest {
  mode: EgressMode;
  presets?: readonly string[];
  domains?: readonly string[];
}

/** A checked policy. `allow` is what the proxy enforces, so it is kept on the spec and shown as it is. */
export interface EgressPolicy {
  mode: EgressMode;
  presets: EgressPreset[];
  domains: string[];
  allow: string[];
}

export const OPEN_EGRESS: EgressPolicy = { mode: "open", presets: [], domains: [], allow: [] };

/** The egress a box holds, as its spec and its container label record it. An open box holds none. */
export interface BoxEgress extends Omit<EgressPolicy, "mode"> {
  mode: Exclude<EgressMode, "open">;
  /** The box's private network. The host firewall keeps the box from reaching the host through it. */
  subnet: string;
}

export function isEgressPreset(value: string): value is EgressPreset {
  return (EGRESS_PRESETS as readonly string[]).includes(value);
}

export function egressPolicyOf(egress: BoxEgress): EgressPolicy {
  return {
    mode: egress.mode,
    presets: [...egress.presets],
    domains: [...egress.domains],
    allow: [...egress.allow],
  };
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Reads the record a container label or a spec holds. Anything that is not a complete egress record is null. */
export function parseBoxEgress(text: string | undefined): BoxEgress | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { mode, presets, domains, allow, subnet } = value as Record<string, unknown>;
  if (mode !== "none" && mode !== "proxy-only") return null;
  if (!isStrings(presets) || !presets.every((preset) => isEgressPreset(preset))) return null;
  if (!isStrings(domains) || !isStrings(allow) || typeof subnet !== "string") return null;
  return { mode, presets: presets as EgressPreset[], domains, allow, subnet };
}

/**
 * A hostname or a `*.` wildcard, lowercased, without a trailing dot. Wildcards match subdomains only, so `*.example.com`
 * matches `api.example.com` and not `example.com`. IP literals and single-label names are refused.
 */
export function normalizeDomain(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = text.startsWith("*.");
  const host = wildcard ? text.slice(2) : text;
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1] ?? "")) return null;
  return wildcard ? `*.${host}` : host;
}

/** True when `host` is one of the allowlist entries: an exact name, or a `*.` wildcard over its subdomains. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => (entry.startsWith("*.") ? name.endsWith(entry.slice(1)) : name === entry));
}

/** The domains a set of presets adds, in preset order. */
export function presetDomains(presets: readonly EgressPreset[]): string[] {
  return presets.flatMap((preset) => PRESET_DOMAINS[preset]);
}

/**
 * Checks a request and returns the policy a box stores. Options that a mode cannot use are refused rather than dropped,
 * so the stored policy always says what the proxy enforces.
 */
export function normalizeEgress(request: EgressRequest): EgressPolicy {
  if (!(EGRESS_MODES as readonly string[]).includes(request.mode)) {
    throw badRequest(msg("egress_mode_invalid", { mode: String(request.mode) }));
  }
  const presets: EgressPreset[] = [];
  for (const preset of request.presets ?? []) {
    if (!isEgressPreset(preset)) throw badRequest(msg("egress_preset_invalid", { preset }));
    if (!presets.includes(preset)) presets.push(preset);
  }
  const domains = new Set<string>();
  for (const raw of request.domains ?? []) {
    const domain = normalizeDomain(raw);
    if (domain === null) throw badRequest(msg("egress_domain_invalid", { domain: raw }));
    domains.add(domain);
  }
  if (request.mode !== "proxy-only" && (presets.length > 0 || domains.size > 0)) {
    throw badRequest(msg("egress_options_need_proxy", { mode: request.mode }));
  }
  if (request.mode === "open") return OPEN_EGRESS;
  if (request.mode === "none") return { mode: "none", presets: [], domains: [], allow: [] };
  const allow = [...new Set([...presetDomains(presets), ...domains])].toSorted();
  if (allow.length > MAX_EGRESS_DOMAINS) {
    throw badRequest(msg("egress_domains_too_many", { max: MAX_EGRESS_DOMAINS }));
  }
  return { mode: "proxy-only", presets, domains: [...domains].toSorted(), allow };
}
