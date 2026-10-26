/** The tab a key press moves to, or null for a key the strip does not handle. Wraps at either end. */
export declare function tabForKey<T extends Element>(tabs: readonly T[], current: T, key: string): T | null;

/**
 * Moves focus between the tabs of one strip on the arrow keys, Home and End, and opens the focused tab on Space. Every
 * other key, Enter and a click among them, is left to the browser so the tab it names still opens.
 */
export declare function onTabKeydown(event: KeyboardEvent): void;
