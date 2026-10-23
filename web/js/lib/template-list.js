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

/** Whether a box created on `hostId` needs the template copied there first: the card exists and the host lacks it. */
export const needsSync = (card, hostId) => card !== undefined && !card.holders.includes(hostId);

/** The size of a template in whole megabytes for the copy notice. A copy under a megabyte still reads as one. */
export const syncSizeMb = (card) => Math.max(1, Math.round(card.size / 1024 ** 2));
