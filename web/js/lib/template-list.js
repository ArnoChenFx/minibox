/**
 * The strings a template card is searched by: its name, its tags and reference, its description, its image id, and the
 * badge the card shows. Pure, so the page and the tests share it.
 */
export function templateSearchFields(template, badge) {
  return [template.name, template.ref, ...template.tags, template.description, template.id, badge];
}

/**
 * One card per template reference. The server lists a copy for each host that holds the template, so copies that share
 * a reference fold into one card that keeps the hosts holding it, in the order the server gave. The details come from the
 * first copy: a copy keeps its image id, so they match on every host.
 */
export function templateCards(rows) {
  const cards = new Map();
  for (const row of rows) {
    const card = cards.get(row.ref);
    if (card) card.holders.push(row.hostId);
    else cards.set(row.ref, { ...row, holders: [row.hostId] });
  }
  return [...cards.values()];
}

/**
 * The official templates no host holds yet, as cards with no holder, after the built ones. A built official template is
 * already a card, so it is not listed twice. `official` is the server's catalog from GET /api/templates/official.
 */
export function withOfficialCards(cards, official) {
  const built = new Set(cards.map((card) => card.ref));
  const unbuilt = official
    .filter((template) => !built.has(template.ref))
    .map((template) => ({
      ref: template.ref,
      name: template.name,
      description: template.description,
      base: template.base,
      buildKind: "official",
      tags: [],
      size: null,
      holders: [],
    }));
  return [...cards, ...unbuilt];
}

/** Whether no host holds the template yet, so a box can only get it by building it. */
export const isUnbuilt = (card) => card !== undefined && card.holders.length === 0;

/**
 * Whether a box created on `hostId` needs the template copied there first: a host holds it, and the host does not. A
 * template no host holds is built instead, see `isUnbuilt`.
 */
export const needsSync = (card, hostId) =>
  card !== undefined && card.holders.length > 0 && !card.holders.includes(hostId);

/** The size of a template in whole megabytes for the copy notice. A copy under a megabyte still reads as one. */
export const syncSizeMb = (card) => Math.max(1, Math.round(card.size / 1024 ** 2));
