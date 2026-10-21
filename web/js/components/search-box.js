import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";

/**
 * A search field for a list page. Render it once, outside the part of the page that is redrawn, so its text, focus and
 * caret survive every redraw. `bindSearchBox` connects it.
 */
export function searchBoxHtml({ id, placeholder, label }) {
  const clear = esc(t("common.clearSearch"));
  return `<div class="input-group search-box" id="${esc(id)}" role="search">${icon("search")}<input class="input" type="search" aria-label="${esc(label)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" /><button type="button" class="icon-btn search-clear" aria-label="${clear}" title="${clear}" hidden>${icon("x")}</button></div>`;
}

/**
 * Connects a field rendered by `searchBoxHtml`. `onChange` receives the text after every edit. Esc, or the clear button,
 * empties the field and focuses it again. The returned `clear()` does the same from the page, such as from an empty state.
 */
export function bindSearchBox(box, onChange) {
  const input = box.querySelector("input");
  const clear = box.querySelector(".search-clear");
  const sync = () => {
    clear.hidden = input.value === "";
  };
  const reset = () => {
    input.value = "";
    sync();
    input.focus();
    onChange("");
  };
  input.addEventListener("input", () => {
    sync();
    onChange(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || input.value === "") return;
    event.preventDefault();
    event.stopPropagation();
    reset();
  });
  clear.addEventListener("click", reset);
  sync();
  return { clear: reset };
}
