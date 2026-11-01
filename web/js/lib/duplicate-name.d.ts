/** A card the duplicate dialog reads: the name it copies, and the description it prefills. */
export interface DuplicableCard {
  name: string;
  description?: string | null;
  [key: string]: unknown;
}

/** A name for a duplicate that is free among `taken`, as `<name>-copy`, `<name>-copy-2` and so on, within 63 characters. */
export declare function duplicateName(name: string, taken?: ReadonlySet<string>): string;

/** The names a duplicate must avoid: every template the page listed. */
export declare function takenNames(cards: readonly DuplicableCard[] | undefined): Set<string>;
