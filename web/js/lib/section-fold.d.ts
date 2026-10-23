/** The ids of the sections saved as folded. */
export declare function loadFolded(): Set<string>;

/** Saves whether section `id` is folded. */
export declare function saveFolded(id: string, folded: boolean): void;

/** How many items are chosen and the first `max` names. */
export declare function chosenSummary(names: readonly string[], max?: number): { count: number; names: string };
