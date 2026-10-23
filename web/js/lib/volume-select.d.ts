/** A volume as the selection reads it: its id, its role, and the boxes that mount it. */
export interface SelectableVolume {
  id: string;
  role: string | null;
  mounts: readonly unknown[];
}

/** A row of a batch delete preview: `blocked` is why the row is not removed, and `trash` whether a copy is kept by default. */
export interface PreviewRow {
  blocked: string | null;
  trash: boolean;
}

export interface HeaderState {
  disabled: boolean;
  checked: boolean;
  indeterminate: boolean;
}

export interface PreviewOutcome {
  removes: boolean;
  keepsCopy: boolean;
  blocked: string | null;
}

/** Why a volume's checkbox is disabled, or null when it can be selected. */
export declare function unselectableReason(volume: SelectableVolume): "tools" | "mounted" | null;

export declare function isSelectable(volume: SelectableVolume): boolean;

/** The selection after the header checkbox is pressed: every selectable match, unless they were all selected already. */
export declare function toggleAll(selected: ReadonlySet<string>, matches: readonly SelectableVolume[]): Set<string>;

/** The selection after one row's checkbox is pressed. A volume that cannot be selected is never added. */
export declare function toggleOne(
  selected: ReadonlySet<string>,
  volume: SelectableVolume,
  checked: boolean,
): Set<string>;

export declare function headerState(selected: ReadonlySet<string>, matches: readonly SelectableVolume[]): HeaderState;

/** The selection without the ids that are gone, or can no longer be selected, once the list is loaded again. */
export declare function keepSelectable(
  selected: ReadonlySet<string>,
  volumes: readonly SelectableVolume[],
): Set<string>;

export declare function tallyRows(rows: readonly { status: string }[]): {
  removed: number;
  refused: number;
  failed: number;
};

export declare function previewOutcome(row: PreviewRow, skipTrash: boolean): PreviewOutcome;
