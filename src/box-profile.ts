/** Security profiles applied to every box container. See `src/docker/hardening.ts` for what each one sets. */
export const BOX_PROFILES = ["standard", "strict", "relaxed"] as const;
export type BoxProfile = (typeof BOX_PROFILES)[number];

export const DEFAULT_BOX_PROFILE: BoxProfile = "standard";

export function isBoxProfile(value: unknown): value is BoxProfile {
  return typeof value === "string" && (BOX_PROFILES as readonly string[]).includes(value);
}
