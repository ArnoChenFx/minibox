/**
 * The strings a template card is searched by: its name, its tags and reference, its description, its image id, and the
 * badge the card shows. Pure, so the page and the tests share it.
 */
export function templateSearchFields(template, badge) {
  return [template.name, template.ref, ...template.tags, template.description, template.id, badge];
}

/**
 * The detail rows a template card shows below its image, size and creation time: the command its devcontainer.json runs
 * once in a created box, and the ports it forwards. A row the template has none of is left out, so the card shows no
 * placeholder for it. A string command is stored as the `sh -c` run it becomes, and the card shows the command itself.
 * Pure, so the page and the tests share it.
 */
export function templateDetailRows(template) {
  const command = template.postCreate;
  const shown =
    command === undefined || command.length === 0
      ? undefined
      : command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c"
        ? command[2]
        : command.join(" ");
  return [
    ...(shown === undefined ? [] : [{ key: "tp.postCreate", text: shown }]),
    ...(template.forwardPorts === undefined || template.forwardPorts.length === 0
      ? []
      : [{ key: "tp.ports", text: template.forwardPorts.join(", ") }]),
  ];
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

/**
 * The templates saved as drafts, as cards with no holder, after the built and official ones. A draft has no image, so it
 * keeps the name it will be built under and the host that saved it, and the card offers building it instead of using it.
 * `drafts` is the server's list from GET /api/templates/drafts. A draft is kept even when a card of the same reference
 * exists: a name is free on each host, so one host may have built `x` while another saved a draft `x`, and the draft is
 * then a different thing that the card's `data-host` still tells apart.
 */
export function withDraftCards(cards, drafts) {
  return [...cards, ...drafts.map((draft) => ({ ...draft, draft: true, tags: [], size: null, holders: [] }))];
}

/**
 * The label a card shows: the bundled base template, one of the official templates, or a custom template. Everything
 * else is custom, including a fork of an official template: the fork keeps its own copy of the Dockerfile, so it reads
 * as built from a Dockerfile and can be edited, unlike the official template it came from.
 */
export function templateBadge(card, base) {
  if (card.draft) return "tp.draft";
  if (card.ref === base) return "tp.builtin";
  return card.buildKind === "official" ? "tp.official" : "tp.custom";
}

/**
 * The fork action a card offers. A card no host holds yet is not forked: a fork copies the built image, so there is
 * nothing to copy until the template is built. The card shows the button off, with `tp.forkUnbuilt` as its reason.
 */
export function forkAction(card) {
  return isUnbuilt(card) ? { enabled: false, reason: "tp.forkUnbuilt" } : { enabled: true, reason: null };
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
