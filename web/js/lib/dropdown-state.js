/**
 * The state of one dropdown menu, kept apart from the DOM so its rules can be tested without a browser. An option is
 * `{ label, disabled }` in the order of the native select, so an index is the option's position in `select.options`.
 *
 * Every reducer returns `{ state, commit, handled, stop }`. `commit` is the index the value should move to, and it is set
 * only when that differs from `selected`. `handled` says the key was used, so the browser default is suppressed. `stop`
 * says the event should not reach the page: Escape closes the menu, and not the dialog around it.
 */

/** Letters typed closer together than this count as one type-ahead search. */
export const TYPEAHEAD_MS = 700;
const PAGE = 10;

export function closedState() {
  return { open: false, active: -1, typed: "", typedAt: 0 };
}

const isEnabled = (options, index) => index >= 0 && index < options.length && !options[index].disabled;
const isCharacter = (key) => [...key].length === 1;
const folded = (label) => label.trim().toLowerCase();
const idle = (state) => ({ state, commit: null, handled: false, stop: false });
const typing = (state, now) => state.typed !== "" && now - state.typedAt <= TYPEAHEAD_MS;

/** The first enabled option after `from` in direction `delta`, or -1. `from` may lie past either end. */
function nextEnabled(options, from, delta) {
  for (let i = from + delta; i >= 0 && i < options.length; i += delta) {
    if (!options[i].disabled) return i;
  }
  return -1;
}

/**
 * Moves the highlight by `count` enabled options and stops at an end. From -1 the walk starts at the top, or at the
 * bottom when it goes up.
 */
export function stepEnabled(options, from, delta, count = 1) {
  let at = from;
  let cursor = from < 0 && delta < 0 ? options.length : from;
  for (let n = 0; n < count; n += 1) {
    const next = nextEnabled(options, cursor, delta);
    if (next === -1) break;
    at = next;
    cursor = next;
  }
  return at;
}

/** The highlight a menu opens on: the selected option, or the first enabled one when that is disabled. */
const highlightOf = (options, selected) => (isEnabled(options, selected) ? selected : nextEnabled(options, -1, 1));

/** The first enabled option whose label starts with `query`, searching from `from` and wrapping around. */
function findFrom(options, query, from, inclusive) {
  const start = from < 0 ? 0 : from + (inclusive ? 0 : 1);
  for (let k = 0; k < options.length; k += 1) {
    const i = (start + k) % options.length;
    if (!options[i].disabled && folded(options[i].label).startsWith(query)) return i;
  }
  return -1;
}

/**
 * Where typing `key` moves the highlight. Letters typed within TYPEAHEAD_MS form one search. A single letter, or one
 * letter repeated, moves to the next option that starts with it, so a repeat cycles through them. When a longer search
 * finds nothing, its newest letter starts a new search.
 */
export function typeAheadMatch(options, from, typed, typedAt, key, now) {
  const text = (now - typedAt <= TYPEAHEAD_MS ? typed : "") + key.toLowerCase();
  const letters = [...text];
  const repeated = letters.every((letter) => letter === letters[0]);
  let index = findFrom(options, repeated ? letters[0] : text, from, !repeated);
  let next = text;
  if (index === -1 && !repeated) {
    next = key.toLowerCase();
    index = findFrom(options, next, from, false);
  }
  return { typed: next, typedAt: now, index };
}

const opened = (options, selected) =>
  options.length ? { open: true, active: highlightOf(options, selected), typed: "", typedAt: 0 } : closedState();

const moved = (state, index) => ({
  state: { ...state, active: index >= 0 ? index : state.active, typed: "", typedAt: 0 },
  commit: null,
  handled: true,
  stop: false,
});

/** Closes the menu on `index`, which moves the value there unless that option is disabled or already selected. */
const choose = (options, selected, index) => ({
  state: closedState(),
  commit: isEnabled(options, index) && index !== selected ? index : null,
  handled: true,
  stop: false,
});

/** Keeps an open menu consistent after its options or the selection changed. */
export function syncState(state, { options, selected }) {
  if (!state.open) return state;
  if (options.length === 0) return closedState();
  return isEnabled(options, state.active) ? state : { ...state, active: highlightOf(options, selected) };
}

function keyWhileClosed(state, key, options, selected, now) {
  if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
    return options.length
      ? { state: opened(options, selected), commit: null, handled: true, stop: false }
      : idle(state);
  }
  if (!isCharacter(key) || options.length === 0) return idle(state);
  const found = typeAheadMatch(options, selected, state.typed, state.typedAt, key, now);
  return {
    state: { ...state, typed: found.typed, typedAt: found.typedAt },
    commit: found.index !== -1 && found.index !== selected ? found.index : null,
    handled: true,
    stop: false,
  };
}

function keyWhileOpen(state, key, options, selected, now) {
  const from = state.active;
  if (key === "ArrowDown") return moved(state, stepEnabled(options, from, 1));
  if (key === "ArrowUp") return moved(state, stepEnabled(options, from, -1));
  if (key === "PageDown") return moved(state, stepEnabled(options, from, 1, PAGE));
  if (key === "PageUp") return moved(state, stepEnabled(options, from, -1, PAGE));
  if (key === "Home") return moved(state, nextEnabled(options, -1, 1));
  if (key === "End") return moved(state, nextEnabled(options, options.length, -1));
  if (key === "Enter" || (key === " " && !typing(state, now))) return choose(options, selected, from);
  if (key === "Escape") return { state: closedState(), commit: null, handled: true, stop: true };
  if (key === "Tab") return { state: closedState(), commit: null, handled: false, stop: false };
  if (!isCharacter(key)) return idle(state);
  const found = typeAheadMatch(options, from >= 0 ? from : selected, state.typed, state.typedAt, key, now);
  return {
    state: { ...state, active: found.index !== -1 ? found.index : from, typed: found.typed, typedAt: found.typedAt },
    commit: null,
    handled: true,
    stop: false,
  };
}

/** A key pressed on the trigger. Closed, arrows, Enter and Space open the menu and a letter selects its match at once. */
export function reduceKey(state, key, { options, selected, now = 0 }) {
  return state.open
    ? keyWhileOpen(state, key, options, selected, now)
    : keyWhileClosed(state, key, options, selected, now);
}

/** A click on the trigger opens a closed menu and closes an open one. */
export function reduceToggle(state, { options, selected }) {
  return idle(state.open ? closedState() : opened(options, selected));
}

/** A click on an option chooses it. A disabled option does nothing. */
export function reducePick(state, index, { options, selected }) {
  return state.open && isEnabled(options, index) ? choose(options, selected, index) : idle(state);
}

/** The pointer moving over an enabled option highlights it. */
export function reduceHover(state, index, { options }) {
  return state.open && isEnabled(options, index) ? idle({ ...state, active: index }) : idle(state);
}

/** Closing without a choice: Tab's neighbour, an outside click, a route change or a lost focus. */
export function reduceDismiss() {
  return idle(closedState());
}
