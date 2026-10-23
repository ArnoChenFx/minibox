/** One page of the activity log. A page longer than this would scroll far; the pager moves through the rest. */
export const PAGE_SIZE = 25;

/** The operation families the category filter offers, each sent as `op=<family>.*`. */
export const CATEGORIES = [
  "box",
  "exec",
  "checkpoint",
  "session",
  "terminal",
  "container",
  "egress",
  "volume",
  "files",
  "template",
  "tool",
  "host",
  "token",
  "self",
];
/** The query for one page: the filters that are set, the routine reads left out unless asked for, and the cursor. */
export function eventsQuery(filters, cursor) {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.box) query.set("box", filters.box);
  if (filters.category) query.set("op", `${filters.category}.*`);
  if (filters.status) query.set("status", filters.status);
  if (filters.principal) query.set("principal", filters.principal);
  if (!filters.reads) query.set("reads", "failed");
  if (cursor) query.set("cursor", String(cursor));
  return `/api/events?${query}`;
}
