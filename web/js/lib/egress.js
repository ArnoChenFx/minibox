/**
 * Helpers for the console's egress controls: the create dialog's tier selector and the box overview's network card.
 * No DOM and no imports, so the tests load them directly. The lists mirror `EGRESS_MODES` and `EGRESS_PRESETS` in
 * src/egress/policy.ts, and the denial reasons the proxy writes in src/egress/proxy.ts.
 */

/** The tiers a box can name, in the order the console offers them. */
export const EGRESS_TIERS = ["open", "none", "proxy-only"];

/** The presets proxy-only offers. The hosts they allow come back from the server in the box's `egress.allow`. */
export const EGRESS_PRESETS = ["agent-default", "package-registries"];

/** Why the proxy refused a connection. A connection that failed after it was allowed has its own event, not a denial. */
export const DENIAL_REASONS = ["not_allowed", "port", "dns_failed", "private_address"];

/** The hosts typed into the allowlist field: one per line, or separated by commas or spaces. Duplicates go. */
export function domainsOf(text) {
  const hosts = String(text ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  return [...new Set(hosts)];
}

/**
 * The `egress` a create body names. An open box sends nothing, so an open create sends the request it always has.
 * Presets and hosts go only with proxy-only, the one tier that uses them.
 */
export function egressRequestOf({ mode, presets = [], domains = "" }) {
  if (!mode || mode === "open") return undefined;
  if (mode !== "proxy-only") return { mode };
  const hosts = domainsOf(domains);
  return {
    mode,
    ...(presets.length > 0 ? { presets: [...presets] } : {}),
    ...(hosts.length > 0 ? { domains: hosts } : {}),
  };
}

/** `proxy-only` reads as `proxyOnly`, the form dictionary keys take. */
const stem = (id) => id.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());

export const tierKey = (mode) => `egress.tier.${stem(mode)}`;
export const tierHintKey = (mode) => `egress.tierHint.${stem(mode)}`;
export const presetKey = (preset) => `egress.preset.${stem(preset)}`;
export const presetHintKey = (preset) => `egress.presetHint.${stem(preset)}`;

/** The label key of a denial reason. The caller checks that the key exists and shows an unknown reason as it came. */
export function denialReasonKey(reason) {
  return `egress.reason.${reason}`;
}
