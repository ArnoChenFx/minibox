/** How many items a long list shows before its toggle expands it. */
export declare const LIST_LIMIT: number;

/** The items with the pinned ones first. Each group keeps the order it had. */
export declare function pinFirst<T>(items: readonly T[], isPinned: (item: T) => boolean): T[];

/**
 * The items a list shows: all of them when expanded or no longer than `limit`, else the first `limit` and every item
 * `keep` marks.
 */
export declare function shownItems<T>(
  items: readonly T[],
  options?: { expanded?: boolean; limit?: number; keep?: (item: T) => boolean },
): readonly T[];

/** Whether a list of `count` items needs a toggle. */
export declare function isLong(count: number, limit?: number): boolean;
