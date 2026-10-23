/** One section of a box's settings tab. */
export interface BoxSettingsSection {
  id: string;
  label: string;
}

export declare const BOX_SETTINGS: readonly BoxSettingsSection[];

/** The section a route names, or the default when the name is missing or unknown. */
export declare function boxSettingsOf(id: string | undefined): BoxSettingsSection;
