/**
 * The categories of the settings page, in the order its sub-nav lists them. The first one is the default, which a route
 * without a category, or with an unknown one, shows. `label` is a dictionary key, the same title the category's card uses.
 */
export const SETTINGS_SECTIONS = [
  { id: "sessions", label: "st.sessions" },
  { id: "tokens", label: "st.tokens" },
  { id: "secrets", label: "st.secrets" },
  { id: "notify", label: "st.notify" },
  { id: "targets", label: "st.targets" },
  { id: "hosts", label: "st.hosts" },
  { id: "runtime", label: "st.runtime" },
  { id: "preview", label: "st.preview" },
  { id: "appearance", label: "st.appearance" },
];

/** The category a route names, or the default when the name is missing or unknown. */
export function sectionOf(id) {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
}
