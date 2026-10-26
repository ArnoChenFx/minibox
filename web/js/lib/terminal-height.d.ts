/** The key the reader's terminal height is remembered under, in `localStorage`. */
export declare const HEIGHT_KEY: string;

/** The shortest the terminal may be dragged to, in pixels. */
export declare const MIN_HEIGHT: number;

/** The tallest the default grows to, in pixels. */
export declare const DEFAULT_MAX: number;

/** The tallest the terminal may be dragged to, on any window, in pixels. */
export declare const MAX_HEIGHT: number;

/** The furniture the stylesheet's first-paint fallback assumes, in pixels. */
export declare const FALLBACK_CHROME: number;

/** How much further than the default a reader may drag the grabber, in pixels. */
export declare const EXTRA_HEIGHT: number;

/** The fixed height the terminal used to have, which the default never opens shorter than. */
export declare const LEGACY_HEIGHT: number;

/** How far one press of an arrow key on the grabber moves the terminal, in pixels. */
export declare const STEP: number;

/** What the page measures about itself: its window, the screen's box, and the bottom of the page content. */
export interface PageRoom {
  viewportHeight: number;
  screenTop: number;
  screenBottom: number;
  contentBottom: number;
}

/**
 * The room the page leaves for the screen: the window's height less the screen's own top and everything the page draws
 * under the screen (the grabber, the help line, the content's bottom padding).
 */
export declare function availableHeight(page: PageRoom): number;

/** The terminal height for `room` pixels of space, before the reader has dragged anything. */
export declare function defaultHeight(room: number): number;

/** The tallest the terminal may be with `room` pixels of space. */
export declare function ceilingHeight(room: number): number;

/** `height` brought inside the range the terminal may take with `room` pixels of space. */
export declare function clampHeight(height: number, room: number): number;

/** The height one step up (`direction` 1) or down (-1) from `height`, kept inside the range above. */
export declare function stepHeight(height: number, direction: number, room: number): number;

/**
 * The height a stored value stands for, or null when it stands for none: a missing key, a value from another version, or
 * anything that is not a whole number of pixels inside the range above.
 */
export declare function parseHeight(raw: string | null | undefined): number | null;

/** The height the reader last set, or null when they never have, or when storage cannot be read. */
export declare function readHeight(storage: Pick<Storage, "getItem"> | null | undefined): number | null;

/** Remembers `height` for the next page, box or session. Storage that refuses is not an error. */
export declare function writeHeight(storage: Pick<Storage, "setItem"> | null | undefined, height: number): void;

/** Forgets the reader's height, so the terminal follows the window again. Storage that refuses is not an error. */
export declare function clearHeight(storage: Pick<Storage, "removeItem"> | null | undefined): void;

/**
 * The height the grabber's key press asks for, or null for a key it does not handle. ArrowUp grows the terminal,
 * ArrowDown shrinks it, and Home, End and Enter restore the default height.
 */
export declare function heightForKey(key: string, height: number, room: number): number | null;

/** Whether a key press on the grabber puts the default height back, rather than stepping one way or the other. */
export declare function resetsHeight(key: string): boolean;
