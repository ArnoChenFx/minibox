/**
 * The Agent CLI picker's groups, search and row actions, shared by the create dialog and the running box's tools panel.
 * Pure: the labels come from the caller, and the functions return category ids for the page to translate.
 */

import { filterBySearch } from "./search.js";

/** The display order of the groups. The ids match the catalog's `category` values. */
export const TOOL_CATEGORY_ORDER = ["agents", "languages", "terminal", "networking"];

/** The strings a tool is searched by: its name, id and description, and its category id and label. */
export function toolSearchFields(tool, categoryLabel) {
  return [tool.name, tool.id, tool.description, tool.category, tool.category && categoryLabel(tool.category)];
}

/** The tools that match the query. A blank query keeps them all. */
export function filterTools(tools, query, categoryLabel) {
  return filterBySearch(tools, query, (tool) => toolSearchFields(tool, categoryLabel));
}

/** The non-empty groups in display order, each holding its tools in catalog order. */
export function groupTools(tools) {
  return TOOL_CATEGORY_ORDER.map((category) => ({
    id: `category:${category}`,
    category,
    rows: tools.filter((tool) => tool.category === category),
  })).filter((group) => group.rows.length > 0);
}

/**
 * What a tool's row offers. `needsRoot` when MiniBox will not run the installer, `install` when the tool is missing,
 * `managed` when the tool sits on the tools volume so MiniBox may upgrade or remove it, and `outside` when it is
 * installed some other way, such as in the image or the home volume.
 */
export function toolAction(tool) {
  if (tool.needsRoot) return "needsRoot";
  if (!tool.installed) return "install";
  return tool.managed ? "managed" : "outside";
}
