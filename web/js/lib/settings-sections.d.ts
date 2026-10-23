/** One category of the settings page. */
export interface SettingsSection {
  id: string;
  label: string;
}

export declare const SETTINGS_SECTIONS: readonly SettingsSection[];

/** The category a route names, or the default when the name is missing or unknown. */
export declare function sectionOf(id: string | undefined): SettingsSection;
