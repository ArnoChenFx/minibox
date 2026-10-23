/**
 * The notice the console shows for the owner access key on /mcp, from `/api/system`: `accepted` or `refused` when an
 * agent used the key in the notice window, and `null` when it did not.
 */
export function ownerKeyNotice(system) {
  const outcome = system?.mcpOwnerKey?.outcome;
  return outcome === "accepted" || outcome === "refused" ? outcome : null;
}
