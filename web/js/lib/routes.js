/**
 * The console's addresses. A tab is part of its page's address, so a tab can be linked, reloaded and bookmarked like a
 * page. Addresses that moved resolve to where they live now, so links made before the navigation changed still open.
 */

/**
 * The sections with tabs. Each tab says whether its address takes one more segment: the box that a checkpoints or tools
 * tab works on, or the template that a templates tab brings into focus.
 */
const SECTIONS = {
  storage: { home: "volumes", crumbs: ["nav.storage"], tabs: { volumes: false, checkpoints: true } },
  library: { home: "templates", crumbs: ["nav.library"], tabs: { templates: true, tools: true } },
};
const SECTION_RE = /^\/(storage|library)(?:\/([^/]+)(?:\/([^/]+))?)?$/;

/**
 * A box's address: `/boxes/:id` opens its overview, `/boxes/:id/:tab` one of its tabs, `/boxes/:id/terminal/:session`
 * one terminal session and `/boxes/:id/settings/:section` one settings section. Any other tab drops a third segment.
 */
const BOX_RE = /^\/boxes\/([^/]+)(?:\/(\w+)(?:\/([^/]+))?)?$/;

/** The pages without tabs. `args` gives what the page's render() receives after its view. */
const PAGES = [
  { re: /^\/overview$/, page: "overview", nav: "overview", crumbs: ["nav.overview"] },
  { re: /^\/activity$/, page: "activity", nav: "activity", crumbs: ["nav.activity"] },
  { re: /^\/boxes$/, page: "boxes", nav: "boxes", crumbs: ["nav.boxes"] },
  { re: /^\/trash$/, page: "trash", nav: "storage", crumbs: ["nav.storage", "nav.trash"] },
  {
    re: /^\/settings(?:\/([^/]*))?$/,
    page: "settings",
    nav: "settings",
    crumbs: ["nav.settings"],
    args: (m) => [m[1] ? decode(m[1]) : undefined],
  },
  { re: /^\/about$/, page: "about", nav: "about", crumbs: ["nav.about"] },
];

/**
 * The addresses that moved. Each one maps the path it matches to the address that opens now. The box tabs that became
 * settings sections keep their links working here, so a bookmark made before the change still opens the same content.
 */
const MOVED = [
  { re: /^\/volumes$/, to: () => "/storage/volumes" },
  { re: /^\/templates$/, to: () => "/library/templates" },
  { re: /^\/templates\/([^/]+)$/, to: (m) => `/library/templates/${m[1]}` },
  { re: /^\/snapshots$/, to: () => "/library/templates" },
  { re: /^\/boxes\/([^/]+)\/(resources|tools|checkpoints)$/, to: (m) => `/boxes/${m[1]}/settings/${m[2]}` },
  { re: /^\/boxes\/([^/]+)\/snapshots$/, to: (m) => `/boxes/${m[1]}/settings/checkpoints` },
  { re: /^\/boxes\/([^/]+)\/logs$/, to: (m) => `/boxes/${m[1]}/activity` },
];

/**
 * Where a console path leads. Returns `{ redirect }` for an address to replace with, `{ page, nav, crumbs, args }` for a
 * page to render, or `null` when no page has that path.
 */
export function resolveRoute(path) {
  const address = path || "/overview";
  const section = address.match(SECTION_RE);
  if (section) return resolveSection(section);
  const moved = MOVED.find(({ re }) => re.test(address));
  if (moved) return { redirect: moved.to(address.match(moved.re)) };
  const box = address.match(BOX_RE);
  if (box) return resolveBox(box);
  for (const route of PAGES) {
    const m = address.match(route.re);
    if (m) return { page: route.page, nav: route.nav, crumbs: route.crumbs, args: route.args?.(m) ?? [] };
  }
  return null;
}

function resolveSection([, section, tab, arg]) {
  const spec = SECTIONS[section];
  if (tab === undefined || !Object.hasOwn(spec.tabs, tab)) return { redirect: `/${section}/${spec.home}` };
  if (arg !== undefined && !spec.tabs[tab]) return { redirect: `/${section}/${tab}` };
  return {
    page: section,
    nav: section,
    crumbs: spec.crumbs,
    args: [tab, arg === undefined ? "" : decode(arg)],
  };
}

function resolveBox([, id, tab, sub]) {
  if (sub !== undefined && tab !== "terminal" && tab !== "settings") return { redirect: `/boxes/${id}/${tab}` };
  const args = [decode(id), tab, sub === undefined ? undefined : decode(sub)];
  return { page: "boxDetail", nav: "boxes", crumbs: ["nav.boxes"], args };
}

/** The address of a tab, with the box or template it works on when it names one. */
export function tabHash(section, tab, arg = "") {
  return `#/${section}/${tab}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

/**
 * The address of a box's tab. The overview is the box's own address, so a link to the box opens it. The settings tab
 * takes the section it names, when it names one.
 */
export function boxHash(id, tab = "overview", section = "") {
  const box = `#/boxes/${encodeURIComponent(id)}`;
  if (tab === "overview") return box;
  if (tab === "settings" && section) return `${box}/settings/${encodeURIComponent(section)}`;
  return `${box}/${tab}`;
}

/**
 * The address that shows the same tab of a box under its new container id, or null when `hash` is not on that box. A
 * rebuild or a move gives a box a new id, so the page moves to the new address and keeps the tab it was on.
 */
export function movedBoxHash(hash, fromId, toId) {
  const from = `#/boxes/${encodeURIComponent(fromId)}`;
  if (hash !== from && !hash.startsWith(`${from}/`)) return null;
  return `#/boxes/${encodeURIComponent(toId)}${hash.slice(from.length)}`;
}

/** The address of a box's terminal, on one of its sessions when `session` names one. */
export function terminalHash(boxId, session = "") {
  return `#/boxes/${encodeURIComponent(boxId)}/terminal${session ? `/${encodeURIComponent(session)}` : ""}`;
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
