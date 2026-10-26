/**
 * The rebuild settings a box's Settings tab stages: the template, the network egress and the security profile. Each one
 * becomes a `StagedFields` entry (see src/specs/staged.ts), so a change waits for the banner's apply instead of
 * rebuilding the box at once. No DOM and no imports that touch it, so the tests load these directly.
 */
import { domainsOf } from "./egress.js";
import { imageRefOk } from "./template-source.js";

/** The profiles a box can hold, in the order the console offers them. Mirrors `BOX_PROFILES` in src/box-profile.ts. */
export const SECURITY_PROFILES = ["standard", "strict", "relaxed"];

/** What the egress form holds: the tier, the presets ticked and the extra hosts typed, one line or comma-separated. */
export function egressDraftOf(egress) {
  const policy = egress ?? null;
  return {
    mode: policy?.mode ?? "open",
    presets: [...(policy?.presets ?? [])],
    domains: (policy?.domains ?? []).join(", "),
  };
}

/**
 * The `egress` a staged change names. A create leaves an open policy out of its body, but a staged one has to name it:
 * staging `{ mode: "open" }` is what takes a box back from a restricted tier, and a field left out keeps its staged value.
 */
export function egressFieldOf({ mode, presets = [], domains = "" }) {
  if (mode !== "proxy-only") return { mode };
  const hosts = domainsOf(domains);
  return {
    mode,
    ...(presets.length > 0 ? { presets: [...presets] } : {}),
    ...(hosts.length > 0 ? { domains: hosts } : {}),
  };
}

/** A draft as one string, so two drafts that hold the same policy compare equal. Hosts are compared as parsed. */
const draftKey = (draft) =>
  draft.mode === "proxy-only"
    ? JSON.stringify([draft.mode, [...draft.presets].toSorted(), domainsOf(draft.domains).toSorted()])
    : draft.mode;

/** Whether two egress drafts hold the same policy, so a save that changes nothing stages nothing. */
export const sameEgressDraft = (a, b) => draftKey(a) === draftKey(b);

/**
 * The `profile` a staged change names, or null for a name the console does not offer. A profile is never cleared: a box
 * created before profiles existed keeps the one it has, and the staged field cannot hold `null`.
 */
export function profileFieldOf(profile) {
  return SECURITY_PROFILES.includes(profile) ? { profile } : null;
}

/**
 * The `template` a staged change names, or `{ problem }` with the dictionary key of the refusal. The rule is the
 * server's, so a reference it would refuse is caught before the request.
 */
export function templateFieldOf(ref) {
  const text = String(ref ?? "").trim();
  if (!imageRefOk(text)) return { problem: "tp.errImageRef" };
  return { template: text };
}

/** Whether a staged template is the one the box runs, so a save that changes nothing stages nothing. */
export const sameTemplate = (box, ref) => String(box?.template ?? "") === String(ref ?? "").trim();
