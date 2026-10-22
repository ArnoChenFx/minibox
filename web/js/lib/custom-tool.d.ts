export type CommandField = "install" | "upgrade" | "uninstall" | "detect";

export interface CommandTemplate {
  install: string;
  upgrade: string;
  uninstall: string;
  detect: string;
}

/** A custom entry as the API reports it. */
export interface CustomEntryLike extends CommandTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  package: string;
  bin: string;
  requires: string | null;
  estimatedMb: number;
  needsRoot: boolean;
  overridesBuiltin: boolean;
}

/** The form's values, as the inputs hold them. */
export interface CustomToolValues extends CommandTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  package: string;
  bin: string;
  requires: string;
  estimatedMb: string | number;
  needsRoot: boolean;
  overrideBuiltin: boolean;
}

export declare const COMMAND_FIELDS: readonly CommandField[];
export declare const CUSTOM_LIMITS: Readonly<{
  id: number;
  name: number;
  description: number;
  package: number;
  bin: number;
  requires: number;
  command: number;
}>;

export declare function commandTemplate(source: string): CommandTemplate | null;
export declare function commandsForSource(
  commands: Readonly<Record<CommandField, string>>,
  fromSource: string,
  toSource: string,
): CommandTemplate;
export declare function customToolForm(entry: CustomEntryLike | null): CustomToolValues;
export declare function validCustomId(id: string): boolean;
export declare function isBuiltinId(
  id: string,
  catalogIds: ReadonlySet<string>,
  customById: ReadonlyMap<string, { overridesBuiltin: boolean }>,
): boolean;
export declare function customToolBody(values: CustomToolValues): Record<string, unknown>;
