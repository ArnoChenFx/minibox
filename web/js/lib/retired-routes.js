/** Console addresses that no longer have a page, and the address each one opens instead. */
const RETIRED = { "/snapshots": "/templates" };

/** The hash a retired address opens, or "" when the path is still a page. */
export function retiredRedirect(path) {
  return Object.hasOwn(RETIRED, path) ? `#${RETIRED[path]}` : "";
}
