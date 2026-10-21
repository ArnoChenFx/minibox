export interface DropdownOption {
  label: string;
  disabled: boolean;
}

export interface DropdownState {
  open: boolean;
  active: number;
  typed: string;
  typedAt: number;
}

export interface DropdownContext {
  options: readonly DropdownOption[];
  selected: number;
  now?: number;
}

export interface DropdownResult {
  state: DropdownState;
  commit: number | null;
  handled: boolean;
  stop: boolean;
}

export declare const TYPEAHEAD_MS: number;

export declare function closedState(): DropdownState;

export declare function stepEnabled(
  options: readonly DropdownOption[],
  from: number,
  delta: number,
  count?: number,
): number;

export declare function typeAheadMatch(
  options: readonly DropdownOption[],
  from: number,
  typed: string,
  typedAt: number,
  key: string,
  now: number,
): { typed: string; typedAt: number; index: number };

export declare function syncState(
  state: DropdownState,
  context: Pick<DropdownContext, "options" | "selected">,
): DropdownState;

export declare function reduceKey(state: DropdownState, key: string, context: DropdownContext): DropdownResult;

export declare function reduceToggle(
  state: DropdownState,
  context: Pick<DropdownContext, "options" | "selected">,
): DropdownResult;

export declare function reducePick(
  state: DropdownState,
  index: number,
  context: Pick<DropdownContext, "options" | "selected">,
): DropdownResult;

export declare function reduceHover(
  state: DropdownState,
  index: number,
  context: Pick<DropdownContext, "options">,
): DropdownResult;

export declare function reduceDismiss(): DropdownResult;
