import { el } from "../lib/dom.js";
import {
  closedState,
  reduceDismiss,
  reduceHover,
  reduceKey,
  reducePick,
  reduceToggle,
  syncState,
} from "../lib/dropdown-state.js";
import { icon } from "../lib/icons.js";

/**
 * A menu for every `select.select` in the console. The native select stays in the DOM, hidden, and remains the source
 * of truth for the value, the name, `disabled` and the `input` and `change` events, so page code reads and listens to
 * it as before. A trigger beside it shows the current label, and one popover in `body` lists the options. The popover
 * is outside every dialog and scroll container, so nothing clips it.
 *
 * Pages change selects in three ways, and each has a hook: a body-wide observer enhances the selects that are added and
 * destroys the ones that leave the document; a per-select observer follows options and attributes; and the `value` and
 * `selectedIndex` setters are wrapped, because a programmatic write fires no mutation record. A `change` event re-reads
 * the selection too, which covers an option whose `selected` flag is set directly.
 */

const MENU_ID = "dd-menu";
const MAX_MENU_HEIGHT = 320;
const EDGE = 8;
const GAP = 4;
const WATCHED_ATTRIBUTES = ["class", "disabled", "hidden", "label", "selected", "style"];

const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
const nativeIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");

const controls = new Map();
let menu = null;
let openControl = null;
let renderedShape = "";
let placeFrame = 0;
let started = false;

const optionId = (index) => `dd-menu-option-${index}`;
const optionAt = (target) => (target instanceof Element ? target.closest("[role='option']") : null);

function setAttr(node, name, value) {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

const isDisabled = (option) =>
  option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);

/** The select's options in order, with each optgroup header in place. An option's `index` is its position in `select.options`. */
function readItems(select) {
  const items = [];
  let index = 0;
  const addOption = (node, grouped) => {
    items.push({ group: false, index, label: node.label, disabled: isDisabled(node), grouped });
    index += 1;
  };
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      items.push({ group: true, label: child.label, disabled: child.disabled });
      for (const node of child.children) if (node instanceof HTMLOptionElement) addOption(node, true);
    } else if (child instanceof HTMLOptionElement) {
      addOption(child, false);
    }
  }
  return items;
}

/** The label's text without the select inside it or the trigger that follows it, so the name is the caption alone. */
function textOutside(node) {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.data;
    else if (child instanceof Element && !child.matches("select, .dropdown-trigger")) text += textOutside(child);
  }
  return text;
}

function accessibleName(select) {
  const own = select.getAttribute("aria-label")?.trim();
  if (own) return own;
  return [...select.labels].map(textOutside).join(" ").replace(/\s+/g, " ").trim();
}

function optionNode(item) {
  const node = document.createElement("div");
  node.className = "dropdown-option";
  node.id = optionId(item.index);
  node.dataset.index = String(item.index);
  node.setAttribute("role", "option");
  if (item.disabled) node.setAttribute("aria-disabled", "true");
  const text = document.createElement("span");
  text.className = "dropdown-option-text";
  text.textContent = item.label;
  node.append(el(icon("check", "dropdown-check")), text);
  return node;
}

function groupNode(item) {
  const group = document.createElement("div");
  group.className = "dropdown-group";
  group.setAttribute("role", "group");
  if (item.label) group.setAttribute("aria-label", item.label);
  const head = document.createElement("div");
  head.className = "dropdown-group-label";
  head.setAttribute("role", "presentation");
  head.textContent = item.label;
  group.append(head);
  return group;
}

function renderMenu(control) {
  const nodes = [];
  let group = null;
  for (const item of control.items) {
    if (item.group) {
      group = groupNode(item);
      nodes.push(group);
    } else if (item.grouped && group) {
      group.append(optionNode(item));
    } else {
      nodes.push(optionNode(item));
    }
  }
  menu.replaceChildren(...nodes);
  renderedShape = control.shape;
}

/** Puts the popover under the trigger, or above it when there is no room below, and never wider than the viewport. */
function placeMenu(control) {
  const rect = control.trigger.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  menu.style.minWidth = `${rect.width}px`;
  menu.style.maxWidth = `${viewportWidth - EDGE * 2}px`;
  menu.style.maxHeight = `${MAX_MENU_HEIGHT}px`;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const below = viewportHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const flip = height > below && above > below;
  const maxHeight = Math.max(0, Math.min(MAX_MENU_HEIGHT, flip ? above : below));
  const left = Math.max(EDGE, Math.min(rect.left, viewportWidth - EDGE - width));
  const top = flip ? rect.top - GAP - Math.min(height, maxHeight) : rect.bottom + GAP;
  menu.style.maxHeight = `${maxHeight}px`;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function revealActive(control) {
  const node = document.getElementById(optionId(control.state.active));
  if (!node || !menu.contains(node)) return;
  const top = node.offsetTop;
  const bottom = top + node.offsetHeight;
  if (top < menu.scrollTop) menu.scrollTop = top;
  else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
}

function highlightMenu(control, reveal) {
  if (renderedShape !== control.shape) {
    renderMenu(control);
    placeMenu(control);
  }
  const { active } = control.state;
  const selected = control.select.selectedIndex;
  for (const node of menu.querySelectorAll("[role='option']")) {
    const index = Number(node.dataset.index);
    node.classList.toggle("is-active", index === active);
    node.setAttribute("aria-selected", String(index === selected));
  }
  setAttr(control.trigger, "aria-activedescendant", active >= 0 ? optionId(active) : null);
  if (reveal) revealActive(control);
}

function openMenu(control) {
  if (openControl) {
    const other = openControl;
    other.state = closedState();
    closeMenu(other);
  }
  openControl = control;
  menu.hidden = false;
  setAttr(menu, "aria-label", control.trigger.getAttribute("aria-label"));
  setAttr(menu, "aria-labelledby", control.trigger.getAttribute("aria-labelledby"));
  control.trigger.setAttribute("aria-expanded", "true");
  renderMenu(control);
  placeMenu(control);
  highlightMenu(control, true);
}

function closeMenu(control) {
  if (openControl !== control) return;
  openControl = null;
  menu.hidden = true;
  menu.replaceChildren();
  renderedShape = "";
  control.trigger.setAttribute("aria-expanded", "false");
  control.trigger.removeAttribute("aria-activedescendant");
}

function isInView(node) {
  const rect = node.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function schedulePlace() {
  if (placeFrame || !openControl) return;
  placeFrame = requestAnimationFrame(() => {
    placeFrame = 0;
    const control = openControl;
    if (!control) return;
    if (isInView(control.trigger)) placeMenu(control);
    else control.settle(reduceDismiss());
  });
}

function onMenuClick(event) {
  const control = openControl;
  const node = optionAt(event.target);
  if (!control || !node) return;
  control.settle(reducePick(control.state, Number(node.dataset.index), control.context()), event);
}

function onMenuMove(event) {
  const control = openControl;
  const node = optionAt(event.target);
  if (!control || !node) return;
  const index = Number(node.dataset.index);
  if (index !== control.state.active) control.settle(reduceHover(control.state, index, control.context()));
}

/**
 * A press outside the open menu only closes it. The press is stopped here so that a dialog behind the menu does not
 * also close when its backdrop is clicked.
 */
function onPointerDown(event) {
  const control = openControl;
  if (!control) return;
  const target = event.target;
  if (target instanceof Node && (control.trigger.contains(target) || menu.contains(target))) return;
  event.stopPropagation();
  control.settle(reduceDismiss());
}

function onScroll(event) {
  if (openControl && !(event.target instanceof Node && menu.contains(event.target))) schedulePlace();
}

function onBodyMutations(records) {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element && node.isConnected) enhanceSelects(node);
    }
  }
  for (const [select, control] of controls) {
    if (!select.isConnected) control.destroy();
  }
}

class SelectControl {
  state = closedState();
  items = [];
  options = [];
  shape = "";

  constructor(select) {
    this.select = select;
    this.trigger = document.createElement("span");
    this.trigger.className = "select dropdown-trigger";
    this.trigger.setAttribute("role", "combobox");
    this.trigger.setAttribute("aria-haspopup", "listbox");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("aria-controls", MENU_ID);
    this.valueBox = document.createElement("span");
    this.valueBox.className = "dropdown-value";
    this.current = document.createElement("span");
    this.current.className = "dropdown-current";
    this.valueBox.append(this.current);
    this.trigger.append(this.valueBox);
  }

  mount() {
    const { select, trigger } = this;
    select.classList.add("dropdown-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select.after(trigger);
    select.addEventListener("focus", this.onNativeFocus);
    select.addEventListener("change", this.onNativeChange);
    trigger.addEventListener("click", this.onClick);
    trigger.addEventListener("keydown", this.onKeyDown);
    trigger.addEventListener("blur", this.onBlur);
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(select, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    Object.defineProperties(select, {
      value: {
        configurable: true,
        get: () => nativeValue.get.call(select),
        set: (value) => {
          nativeValue.set.call(select, value);
          this.sync();
        },
      },
      selectedIndex: {
        configurable: true,
        get: () => nativeIndex.get.call(select),
        set: (index) => {
          nativeIndex.set.call(select, index);
          this.sync();
        },
      },
    });
    this.sync();
  }

  destroy() {
    const { select, trigger } = this;
    this.observer.disconnect();
    closeMenu(this);
    this.state = closedState();
    select.removeEventListener("focus", this.onNativeFocus);
    select.removeEventListener("change", this.onNativeChange);
    delete select.value;
    delete select.selectedIndex;
    select.classList.remove("dropdown-native");
    select.removeAttribute("tabindex");
    select.removeAttribute("aria-hidden");
    trigger.remove();
    controls.delete(select);
  }

  /** Brings the trigger, the open menu and the sizer in line with the select. Safe to call at any time. */
  sync() {
    const { select, trigger } = this;
    if (select.nextElementSibling !== trigger) select.after(trigger);
    const items = readItems(select);
    const shape = JSON.stringify(items);
    if (shape !== this.shape) {
      this.shape = shape;
      this.options = items.filter((item) => !item.group);
      this.buildSizers();
    }
    this.items = items;
    this.paint();
    const next = select.disabled ? closedState() : syncState(this.state, this.context());
    if (next.open || this.state.open) this.transition(next);
  }

  /** One hidden copy of each label gives the trigger the width of its widest option, as a native select does. */
  buildSizers() {
    const sizers = this.options.map((option) => {
      const node = document.createElement("span");
      node.className = "dropdown-size";
      node.setAttribute("aria-hidden", "true");
      node.textContent = option.label;
      return node;
    });
    this.valueBox.replaceChildren(...sizers, this.current);
  }

  paint() {
    const { select, trigger, current } = this;
    const text = this.options[select.selectedIndex]?.label ?? "";
    if (current.textContent !== text) current.textContent = text;
    setAttr(trigger, "aria-label", accessibleName(select) || null);
    setAttr(trigger, "aria-labelledby", select.getAttribute("aria-labelledby"));
    const disabled = select.disabled;
    setAttr(trigger, "aria-disabled", disabled ? "true" : null);
    setAttr(trigger, "tabindex", disabled ? "-1" : "0");
    trigger.classList.toggle("hidden", select.hidden || select.classList.contains("hidden"));
    if (trigger.style.cssText !== select.style.cssText) trigger.style.cssText = select.style.cssText;
  }

  context() {
    return { options: this.options, selected: this.select.selectedIndex };
  }

  settle({ state, commit, handled, stop }, event) {
    if (event && handled) event.preventDefault();
    if (event && stop) event.stopPropagation();
    this.transition(state, event?.type === "keydown");
    if (commit !== null) this.commit(commit);
  }

  transition(next, reveal = false) {
    this.state = next;
    if (!next.open) closeMenu(this);
    else if (openControl === this) highlightMenu(this, reveal);
    else openMenu(this);
  }

  /** Writes the chosen index to the native select and fires the events a native choice would. */
  commit(index) {
    const { select } = this;
    if (select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  onNativeFocus = () => {
    if (!this.select.disabled) this.trigger.focus();
  };

  onNativeChange = () => this.sync();

  onClick = (event) => {
    event.preventDefault();
    if (this.select.disabled) return;
    this.settle(reduceToggle(this.state, this.context()));
  };

  onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || this.select.disabled) return;
    this.settle(reduceKey(this.state, event.key, { ...this.context(), now: performance.now() }), event);
  };

  onBlur = () => {
    if (openControl === this) this.settle(reduceDismiss());
  };
}

/** Enhances one select, or returns its existing control. Multiple-choice and list-box selects keep their native UI. */
export function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.multiple || select.size > 1) return null;
  const existing = controls.get(select);
  if (existing) {
    existing.sync();
    return existing;
  }
  const control = new SelectControl(select);
  controls.set(select, control);
  control.mount();
  return control;
}

/** Enhances every `select.select` at or below `root`. Calling it again only refreshes the selects already enhanced. */
export function enhanceSelects(root = document) {
  if (root instanceof Element && root.matches("select.select")) enhanceSelect(root);
  for (const select of root.querySelectorAll("select.select")) enhanceSelect(select);
}

/** Starts the central hook. Safe to call once at boot; later calls do nothing. */
export function initDropdowns() {
  if (started) return;
  started = true;
  menu = document.createElement("div");
  menu.id = MENU_ID;
  menu.className = "dropdown-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  menu.addEventListener("click", onMenuClick);
  menu.addEventListener("pointermove", onMenuMove);
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  document.body.append(menu);
  new MutationObserver(onBodyMutations).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", schedulePlace);
  window.addEventListener("hashchange", () => openControl?.settle(reduceDismiss()));
  enhanceSelects(document);
}
