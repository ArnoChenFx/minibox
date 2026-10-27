/** A card the fork dialog reads: the name it copies, and the description it prefills. */
export interface ForkableCard {
  name: string;
  description?: string | null;
  [key: string]: unknown;
}

/** A name for a fork that is free among `taken`, as `<name>-copy`, `<name>-copy-2` and so on, within 63 characters. */
export declare function forkName(name: string, taken?: ReadonlySet<string>): string;

/** The names a fork must avoid: every template the page listed. */
export declare function takenNames(cards: readonly ForkableCard[] | undefined): Set<string>;
