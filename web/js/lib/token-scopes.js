/**
 * What the token pages say about a token's scopes. The scope groups and the presets come from the server
 * (GET /api/tokens/presets), so this file keeps no scope list of its own.
 */

/** The scope ids of the groups, in the order the server lists them. */
export function allScopes(catalog) {
  return catalog.groups.flatMap((group) => group.scopes);
}

/** Whether two scope lists hold the same scopes, whatever their order. */
export function sameScopes(a, b) {
  return a.length === b.length && a.every((scope) => b.includes(scope));
}

/**
 * Whether `scopes` are what `preset` grants. `volume:attach` is added by the server when a
 * token is granted volumes, so a token with volumes keeps the preset name when that is its only difference.
 */
export function matchesPreset(scopes, preset, grantsVolumes = false) {
  if (sameScopes(scopes, preset.scopes)) return true;
  return (
    grantsVolumes &&
    !preset.scopes.includes("volume:attach") &&
    sameScopes(
      scopes.filter((scope) => scope !== "volume:attach"),
      preset.scopes,
    )
  );
}

/** `{ kind: "preset", name }` when the token's scopes are its preset's, otherwise `{ kind: "custom", base, count }`. */
export function summarizeScopes(token, catalog) {
  const preset = token.preset ? catalog?.presets.find((item) => item.name === token.preset) : undefined;
  const grantsVolumes = token.volumes.type === "all" || token.volumes.ids.length > 0;
  if (token.preset && (!preset || matchesPreset(token.scopes, preset, grantsVolumes))) {
    return { kind: "preset", name: token.preset, count: token.scopes.length };
  }
  return { kind: "custom", base: token.preset ?? null, count: token.scopes.length };
}

/** The body fields for the scopes ticked in the dialog: the preset, plus `scopes` only when they differ from it. */
export function scopeRequest(presetName, chosen, catalog) {
  const preset = catalog.presets.find((item) => item.name === presetName);
  if (!preset) throw new Error(`unknown preset ${presetName}`);
  const ordered = allScopes(catalog).filter((scope) => chosen.includes(scope));
  return sameScopes(ordered, preset.scopes) ? { preset: presetName } : { preset: presetName, scopes: ordered };
}
