/**
 * The sections of a box's settings tab, in the order its sub-nav lists them. The first one is the default, which a
 * settings address without a section, or with an unknown one, shows. `label` is a dictionary key.
 */
export const BOX_SETTINGS = [
  { id: "resources", label: "bd.setResources" },
  { id: "storage", label: "bd.setStorage" },
  { id: "tools", label: "bd.setTools" },
  { id: "env", label: "bd.setEnv" },
  { id: "lifecycle", label: "bd.setLifecycle" },
  { id: "security", label: "bd.setSecurity" },
  { id: "checkpoints", label: "bd.setCheckpoints" },
];

/** The section a route names, or the default when the name is missing or unknown. */
export function boxSettingsOf(id) {
  return BOX_SETTINGS.find((section) => section.id === id) ?? BOX_SETTINGS[0];
}
