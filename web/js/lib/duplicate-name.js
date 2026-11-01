/** The longest template name, the same rule the server applies (`NAME_RE`). */
const NAME_MAX = 63;

/** `stem` and `tail` joined within the name limit, trimming the stem and dropping a separator it leaves behind. */
function joinName(stem, tail) {
  const room = NAME_MAX - tail.length;
  const cut = stem.slice(0, room).replace(/[-_.]+$/, "");
  return `${cut || "template"}${tail}`;
}

/**
 * A name for a duplicated template: `<name>-copy`, then `<name>-copy-2`, `-copy-3` and so on. A suffix that would push the
 * name past 63 characters is cut from the source name first, so a long name still gets a valid one. `taken` is the set of
 * names the host already holds. Pure, so the duplicate dialog and the tests share it.
 */
export function duplicateName(name, taken = new Set()) {
  const stem = String(name ?? "");
  const first = joinName(stem, "-copy");
  if (!taken.has(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = joinName(stem, `-copy-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return first;
}

/** The names a duplicate must avoid: every template the page listed, whichever host holds it. */
export function takenNames(cards) {
  return new Set((cards ?? []).map((card) => card.name));
}
