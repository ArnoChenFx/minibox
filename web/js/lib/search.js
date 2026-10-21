/**
 * Search for the list pages. A query is split on whitespace, and an item matches when every term appears, ignoring
 * case, in one of its fields. A blank query matches everything. Pure, so the pages and the tests share it.
 */

/** The terms of a query: trimmed, lower-cased and split on whitespace. */
export function searchTerms(query) {
  return String(query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

const matchesTerms = (terms, fields) => {
  const text = fields.filter((field) => field != null && field !== "").map((field) => String(field).toLowerCase());
  return terms.every((term) => text.some((field) => field.includes(term)));
};

/** Whether the fields match the query. Missing and empty fields are skipped. */
export const matchesSearch = (query, fields) => matchesTerms(searchTerms(query), fields);

/** The items that match the query. `fieldsOf` lists the strings each item is searched by. */
export function filterBySearch(items, query, fieldsOf) {
  const terms = searchTerms(query);
  if (!terms.length) return items;
  return items.filter((item) => matchesTerms(terms, fieldsOf(item)));
}
