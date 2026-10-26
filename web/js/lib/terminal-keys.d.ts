export interface TermKey {
  /** The id the markup carries as `data-key`. */
  id: string;
  /** What the button shows, such as `Esc` or `^C`. Symbols are the same in every language. */
  label: string;
  /** The dictionary key of the button's `aria-label`. */
  aria: string;
  /** The bytes the key sends. Absent for the sticky Ctrl, which sends nothing on its own. */
  bytes?: string;
  /** True for the Ctrl modifier, which arms the next typed character instead of sending anything. */
  sticky?: boolean;
}

/** The keys of the terminal's auxiliary row, in the order the row shows them. */
export declare const TERM_KEYS: readonly TermKey[];

/** The bytes a key sends, or null when the key sends nothing of its own. */
export declare function keyBytes(id: string): string | null;

/**
 * The control character the sticky Ctrl makes out of one typed character, or null when it leaves the character as it is.
 * Multi-character input, such as a paste, is never turned into a control character.
 */
export declare function ctrlChar(data: string): string | null;

/** A box, as `getBoundingClientRect()` reports it. */
export interface Rect {
  top: number;
  bottom: number;
}

/** How far to scroll to bring the key row into the visible part of the window; zero when it is already there. */
export declare function keysReveal(row: Rect, visible: Rect): number;
