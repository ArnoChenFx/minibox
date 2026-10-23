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

/** The pages without tabs. `args` gives what the page's render() receives after its view. */
const PAGES = [
  { re: /^\/overview$/, page: "overview", nav: "overview", crumbs: ["nav.overview"] },
  {
    re: /^\/activity$/,
    page: "overview",
    nav: "activity",
    crumbs: ["nav.overview", "nav.activity"],
    args: () => ["activity"],
  },
  { re: /^\/boxes$/, page: "boxes", nav: "boxes", crumbs: ["nav.boxes"] },
  {
    re: /^\/boxes\/([^/]+)(?:\/(\w+))?$/,
    page: "boxDetail",
    nav: "boxes",
    crumbs: ["nav.boxes"],
    args: (m) => [decode(m[1]), m[2]],
  },
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

/** The addresses that moved. Each one maps the path it matches to the address that opens now. */
const MOVED = [
  { re: /^\/volumes$/, to: () => "/storage/volumes" },
  { re: /^\/templates$/, to: () => "/library/templates" },
  { re: /^\/templates\/([^/]+)$/, to: (m) => `/library/templates/${m[1]}` },
  { re: /^\/snapshots$/, to: () => "/library/templates" },
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

/** The address of a tab, with the box or template it works on when it names one. */
export function tabHash(section, tab, arg = "") {
  return `#/${section}/${tab}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
