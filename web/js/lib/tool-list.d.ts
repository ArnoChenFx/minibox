/** The fields of a catalog tool that the picker reads. */
export interface CatalogTool {
  id: string;
  name: string;
  description: string;
  category: string;
  source?: string;
  requires?: string | null;
  estimatedMb?: number;
  needsRoot?: boolean;
  installed?: boolean;
  managed?: boolean;
}

/** The display order of the groups. The ids match the catalog's `category` values. */
export declare const TOOL_CATEGORY_ORDER: string[];

export declare function toolSearchFields(tool: CatalogTool, categoryLabel: (id: string) => string): unknown[];

/** The tools that match the query. A blank query keeps them all. */
export declare function filterTools<T extends CatalogTool>(
  tools: readonly T[],
  query: string,
  categoryLabel: (id: string) => string,
): T[];

export interface ToolGroup<T> {
  id: string;
  category: string;
  rows: T[];
}

/** The non-empty groups in display order, each holding its tools in catalog order. */
export declare function groupTools<T extends CatalogTool>(tools: readonly T[]): ToolGroup<T>[];

export declare function toolAction(tool: CatalogTool): "needsRoot" | "install" | "managed" | "outside";

export interface PickerGroup<T> {
  id: string;
  category: string;
  count: number;
  folded: boolean;
  rows: T[];
}

export interface PickerView<T> {
  groups: PickerGroup<T>[];
  count: number;
  toggle: boolean;
}

/** What the tool picker draws for a query and the choices made so far. */
export declare function pickerView<T extends CatalogTool>(
  tools: readonly T[],
  options: {
    query?: string;
    categoryLabel?: (id: string) => string;
    selected: ReadonlySet<string>;
    expanded?: boolean;
    isFolded?: (groupId: string) => boolean;
  },
): PickerView<T>;
